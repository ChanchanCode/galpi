// Electron main process — 파일 IO, 메뉴, 문서 데이터 접근 (명세 §12, §10).
// 경로는 app.getPath('userData') 로 OS-중립 (macOS/Windows 양쪽 동작).
import { app, BrowserWindow, ipcMain, protocol, dialog, net } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";

const isDev = !app.isPackaged;

// 파이프라인(Python) 위치 — 추출/번역 서버 공유. dev: repo/pipeline.
// 환경변수로 재정의 가능(패키징 시 별도 설정).
function pipelineDir(): string {
  return process.env.PAPER_PIPELINE_DIR || path.resolve(__dirname, "../../pipeline");
}
function venvPython(): string {
  return process.env.PAPER_PYTHON || path.join(pipelineDir(), ".venv", "bin", "python");
}

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

// ── 로컬 번역 서버(NLLB) 프록시 (명세 §1.2 보안: 로컬 전용) ──────────────
const TRANSLATE_PORT = 8765;
let translateProc: ChildProcess | null = null;

async function ensureTranslateServer(): Promise<boolean> {
  // 이미 떠 있으면 health 로 확인
  try {
    const r = await fetch(`http://127.0.0.1:${TRANSLATE_PORT}/health`);
    if (r.ok) return true;
  } catch {
    /* 아직 안 떠 있음 */
  }
  if (!translateProc) {
    const py = venvPython();
    const script = path.join(pipelineDir(), "translate_server.py");
    translateProc = spawn(py, [script, "--port", String(TRANSLATE_PORT)], {
      cwd: pipelineDir(),
      stdio: "ignore",
    });
    translateProc.on("exit", () => (translateProc = null));
  }
  // health 폴링(모델 지연 로드는 첫 요청에서 발생하므로 서버 기동만 대기)
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${TRANSLATE_PORT}/health`);
      if (r.ok) return true;
    } catch {
      /* 재시도 */
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

ipcMain.handle("translate:text", async (_e, text: string, src = "en", tgt = "ko") => {
  const up = await ensureTranslateServer();
  if (!up) return { error: "번역 서버를 시작할 수 없습니다. pipeline/.venv 설치를 확인하세요." };
  try {
    const r = await fetch(`http://127.0.0.1:${TRANSLATE_PORT}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, src, tgt }),
    });
    const data = (await r.json()) as { translation?: string };
    return { translation: data.translation ?? "" };
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

app.on("before-quit", () => {
  if (translateProc) translateProc.kill();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
