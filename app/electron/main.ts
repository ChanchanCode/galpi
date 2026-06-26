// Electron main process — 파일 IO, 메뉴, 문서 데이터 접근 (명세 §12, §10).
// 경로는 app.getPath('userData') 로 OS-중립 (macOS/Windows 양쪽 동작).
import { app, BrowserWindow, ipcMain, protocol, dialog, net } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { watch } from "node:fs";

const isDev = !app.isPackaged;

// paper:// 를 표준·보안 스킴으로 등록 (net.fetch/이미지 로딩 허용). app ready 이전 필수.
protocol.registerSchemesAsPrivileged([
  { scheme: "paper", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// 추출 파이프라인과 공유하는 문서 루트.
// pipeline/extract.py 의 default_output_root() 와 동일 위치를 가리켜야 한다.
// macOS: ~/Library/Application Support/PaperReader/docs
function docsRoot(): string {
  // app.getPath('userData') = ~/Library/Application Support/<appName>.
  // productName 이 "Paper Reader" 라 userData 가 다를 수 있으므로 PaperReader 로 고정.
  const base = path.join(app.getPath("appData"), "PaperReader");
  return path.join(base, "docs");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:5123");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

// ── 문서 자산(이미지 등) 보안 프로토콜 ────────────────────────────────
// 렌더러는 paper://<doc_id>/<상대경로> 로 페이지 PNG/asset 을 로드한다.
// docsRoot 밖 접근은 차단.
function registerDocProtocol() {
  protocol.handle("paper", async (request) => {
    const url = new URL(request.url);
    const docId = url.hostname;
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const target = path.normalize(path.join(docsRoot(), docId, rel));
    if (!target.startsWith(docsRoot())) {
      return new Response("forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

// ── IPC: 문서 데이터/상태 ─────────────────────────────────────────────
async function readJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

ipcMain.handle("docs:list", async () => {
  const root = docsRoot();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const docs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const doc = await readJson(path.join(root, e.name, "document.json"));
      if (!doc) continue; // document.json 없는 폴더는 건너뜀
      const status = await readJson(path.join(root, e.name, "status.json"));
      docs.push({
        doc_id: e.name,
        title: doc.title,
        page_count: doc.page_count,
        // 추출 진행 상태(없으면 done 으로 간주 = 레거시 단일추출 문서)
        state: status?.state ?? "done",
        pages_done: status?.pages_done ?? doc.page_count,
      });
    }
    return docs;
  } catch {
    return [];
  }
});

ipcMain.handle("docs:load", async (_e, docId: string) => {
  const file = path.join(docsRoot(), docId, "document.json");
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw);
});

// state.json 사이드카 읽기/쓰기 (§10). 타이포·하이라이트·읽기위치 영속화.
ipcMain.handle("state:load", async (_e, docId: string) => {
  const file = path.join(docsRoot(), docId, "state.json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
});

ipcMain.handle("state:save", async (_e, docId: string, state: unknown) => {
  const file = path.join(docsRoot(), docId, "state.json");
  await fs.writeFile(file, JSON.stringify(state, null, 2), "utf8");
  return true;
});

// 전역 설정 (§10) — 기본 타이포·폰트·단축키.
ipcMain.handle("settings:load", async () => {
  const file = path.join(app.getPath("appData"), "PaperReader", "settings.json");
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
});

ipcMain.handle("settings:save", async (_e, settings: unknown) => {
  const dir = path.join(app.getPath("appData"), "PaperReader");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify(settings, null, 2));
  return true;
});

// 사용자 폰트 파일 선택 (§6.3).
ipcMain.handle("fonts:pick", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Fonts", extensions: ["ttf", "otf", "woff", "woff2"] }],
  });
  if (res.canceled) return [];
  return Promise.all(
    res.filePaths.map(async (fp) => ({
      name: path.basename(fp),
      dataUrl: `data:font/${path.extname(fp).slice(1)};base64,${(await fs.readFile(fp)).toString("base64")}`,
    })),
  );
});

// ── 문서 폴더 와처: 추출 진행/완료를 뷰어에 라이브 통지 ────────────────
// document.json/status.json 변경 시 'docs:changed' 이벤트를 모든 창에 전송.
// 뷰어: 라이브러리 목록 갱신 + 열린 문서 점진적 이어붙임(페이지 스트리밍).
let watchDebounce: ReturnType<typeof setTimeout> | null = null;
async function startDocsWatcher() {
  const root = docsRoot();
  await fs.mkdir(root, { recursive: true });
  try {
    watch(root, { recursive: true }, (_evt, filename) => {
      if (filename && !/document\.json|status\.json/.test(String(filename))) return;
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send("docs:changed");
      }, 200);
    });
  } catch (e) {
    console.warn("docs watcher 실패:", e);
  }
}

// ── 번역: Gemini API (클라우드, 사용자 본인 무료 키) ───────────────────────
// 키는 전역 settings.json 의 translation.apiKey 에 로컬 저장(앱이 키를 생성/전송하지 않음).
// ⚠️ 선택 텍스트가 Google 로 전송됨 — 미공개 논문이면 주의(설정에서 끄거나 키 미입력).
function settingsPath(): string {
  return path.join(app.getPath("appData"), "PaperReader", "settings.json");
}

const TRANSLATE_PROMPT =
  "You are a translator for an English→Korean reader of finance/economics academic papers. " +
  "Translate the user's selected text into natural, fluent Korean, preserving technical terms with their standard Korean equivalents. " +
  "If the selection is a single word or short phrase, briefly list its main senses relevant to this academic context. " +
  "Respond with ONLY the Korean result — no preamble, no quotes.\n\nText:\n";

ipcMain.handle("translate:text", async (_e, text: string) => {
  const settings = (await readJson(settingsPath())) as
    | { translation?: { apiKey?: string; model?: string } }
    | null;
  const apiKey = settings?.translation?.apiKey?.trim();
  const model = settings?.translation?.model?.trim() || "gemini-2.0-flash";
  if (!apiKey) {
    return { error: "읽기 설정 → 번역에서 Gemini API 키를 입력하세요 (aistudio.google.com 무료 발급)." };
  }
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: TRANSLATE_PROMPT + text }] }],
        generationConfig: { temperature: 0.2 },
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      return { error: `Gemini API 오류 ${r.status}: ${body.slice(0, 160)}` };
    }
    const data = (await r.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const out = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return { translation: out.trim() };
  } catch (err) {
    return { error: String(err) };
  }
});

app.whenReady().then(() => {
  registerDocProtocol();
  createWindow();
  startDocsWatcher();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
