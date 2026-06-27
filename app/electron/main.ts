// Electron main process — 파일 IO, 메뉴, 문서 데이터 접근 (명세 §12, §10).
// 경로는 app.getPath('userData') 로 OS-중립 (macOS/Windows 양쪽 동작).
import { app, BrowserWindow, ipcMain, protocol, dialog, net, shell, nativeImage } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { watch, existsSync } from "node:fs";
import { spawn } from "node:child_process";

const isDev = !app.isPackaged;

// 앱 이름 — dev 에서 메뉴/독이 "Electron" 으로 뜨지 않게(패키징은 productName 적용).
app.setName("갈피");

// dev 용 아이콘 PNG 경로(빌드 리소스). 패키징 앱은 번들 아이콘(.icns)을 씀.
function devIconPath(): string {
  return path.join(__dirname, "../build/icon.png");
}

// 배포용: 친구가 공개 릴리스에서 업데이트를 받아볼 GitHub 저장소.
const RELEASES_REPO = "ChanchanCode/galpi";

function appSupportDir(): string {
  return path.join(app.getPath("appData"), "PaperReader");
}
function settingsPath(): string {
  return path.join(appSupportDir(), "settings.json");
}

// 추출 파이프라인 스크립트(extract.py 등) 위치.
//   dev: repo/pipeline · 패키징: 앱 리소스에 동봉(extraResources) · 환경변수로 재정의 가능.
function pipelineScriptsDir(): string {
  if (process.env.PAPER_PIPELINE_DIR) return process.env.PAPER_PIPELINE_DIR;
  return isDev ? path.resolve(__dirname, "../../pipeline") : path.join(process.resourcesPath, "pipeline");
}

// Python(venv) 위치. 셋업 스크립트가 만드는 기본 위치를 우선 탐색.
//   env PAPER_PYTHON → settings.pythonPath → 기본 pyenv(앱지원폴더) → dev venv.
async function resolvePython(): Promise<string> {
  if (process.env.PAPER_PYTHON) return process.env.PAPER_PYTHON;
  const s = (await readJson(settingsPath())) as { pythonPath?: string } | null;
  if (s?.pythonPath && existsSync(s.pythonPath)) return s.pythonPath;
  const def = path.join(appSupportDir(), "pyenv", "bin", "python");
  if (existsSync(def)) return def;
  const dev = path.resolve(__dirname, "../../pipeline/.venv/bin/python");
  if (existsSync(dev)) return dev;
  return def; // 없으면 기본 경로 반환(상태/에러 메시지에 표시)
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
  // productName("갈피")과 무관하게 데이터 폴더는 PaperReader 로 고정(기존 문서/설정 호환).
  const base = path.join(app.getPath("appData"), "PaperReader");
  return path.join(base, "docs");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    title: "갈피",
    icon: isDev ? devIconPath() : undefined, // mac 패키징은 번들 아이콘 사용
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
      const state = await readJson(path.join(root, e.name, "state.json"));
      docs.push({
        doc_id: e.name,
        title: doc.title,
        authors: doc.authors ?? null,
        journal: doc.journal ?? null,
        page_count: doc.page_count,
        // 추출 진행 상태(없으면 done 으로 간주 = 레거시 단일추출 문서)
        state: status?.state ?? "done",
        pages_done: status?.pages_done ?? doc.page_count,
        // 읽기 상태(§10 사이드카)
        finished: state?.finished ?? false,
        last_read_at: state?.last_read_at ?? null,
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

// 읽기 상태(완독/최근 읽음) 부분 갱신 — 기존 state.json 을 병합 보존.
ipcMain.handle("reading:update", async (_e, docId: string, patch: Record<string, unknown>) => {
  const file = path.join(docsRoot(), docId, "state.json");
  const prev = (await readJson(file)) ?? {};
  const next = { ...prev, ...patch };
  await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8");
  return next;
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
// (settingsPath() 는 상단에 정의)

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
  // 기본 모델: gemini-2.5-flash-lite (무료 할당량 넉넉). 옛 기본값(2.0-flash)은 자동 교체 — 429 회피.
  const saved = settings?.translation?.model?.trim();
  const model = !saved || saved === "gemini-2.0-flash" ? "gemini-2.5-flash-lite" : saved;
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

// ── PDF 드래그-드롭 추출: extract.py 를 자식 프로세스로 실행 ──────────────
// 추출은 document.json/status.json 을 점진 기록 → 와처가 라이브러리를 자동 갱신.
ipcMain.handle("pipeline:extract", async (_e, pdfPath: string) => {
  const py = await resolvePython();
  const scriptsDir = pipelineScriptsDir();
  const script = path.join(scriptsDir, "extract.py");
  if (!existsSync(py)) {
    return {
      error:
        `추출 엔진이 설치되지 않았습니다.\n설정 → 추출 엔진에서 설치 안내를 확인하세요.\n(찾은 경로: ${py})`,
    };
  }
  if (!existsSync(script)) {
    return { error: `extract.py 없음: ${script}` };
  }
  if (!/\.pdf$/i.test(pdfPath)) {
    return { error: "PDF 파일만 추출할 수 있습니다." };
  }
  try {
    const child = spawn(py, [script, pdfPath], { cwd: scriptsDir, stdio: "ignore" });
    let spawnErr: string | null = null;
    child.on("error", (e) => (spawnErr = String(e)));
    // 비동기 시작 — 진행/완료는 status.json 와처가 라이브러리에 반영.
    await new Promise((r) => setTimeout(r, 150));
    return spawnErr ? { error: spawnErr } : { started: true };
  } catch (err) {
    return { error: String(err) };
  }
});

// ── 추출 엔진 상태 / 설정 (배포: 친구가 셋업 후 경로 확인·지정) ──────────
ipcMain.handle("pipeline:status", async () => {
  const python = await resolvePython();
  const scriptsDir = pipelineScriptsDir();
  const script = path.join(scriptsDir, "extract.py");
  return {
    python,
    scriptsDir,
    pythonOk: existsSync(python),
    scriptOk: existsSync(script),
    setupScript: path.join(scriptsDir, "setup-mac.sh"),
  };
});

// Python(venv) 바이너리 직접 지정 — settings.pythonPath 에 저장.
ipcMain.handle("pipeline:pickPython", async () => {
  const res = await dialog.showOpenDialog({
    title: "venv 의 python 실행파일 선택 (예: …/pyenv/bin/python)",
    properties: ["openFile"],
    defaultPath: path.join(appSupportDir(), "pyenv", "bin"),
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  const pythonPath = res.filePaths[0];
  const prev = ((await readJson(settingsPath())) as Record<string, unknown> | null) ?? {};
  await fs.mkdir(appSupportDir(), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify({ ...prev, pythonPath }, null, 2), "utf8");
  return { pythonPath, pythonOk: existsSync(pythonPath) };
});

// 원클릭 추출 엔진 설치 — 동봉된 setup-mac.sh 를 로그인 셸로 실행(사용자 PATH=brew/python 확보),
// 진행 로그를 렌더러로 스트리밍. 친구가 터미널 없이 버튼만 누르면 됨.
ipcMain.handle("pipeline:install", async (e) => {
  const script = path.join(pipelineScriptsDir(), "setup-mac.sh");
  if (!existsSync(script)) return { code: -1, error: `설치 스크립트 없음: ${script}` };
  const send = (line: string) => {
    if (!e.sender.isDestroyed()) e.sender.send("pipeline:install-log", line);
  };
  const shell0 = process.env.SHELL || "/bin/zsh";
  // 로그인 셸(-lc)로 brew/python PATH 확보 + 흔한 경로 보강(GUI 앱은 PATH 가 제한적)
  const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` };
  return await new Promise<{ code: number; error?: string }>((resolve) => {
    let child;
    try {
      child = spawn(shell0, ["-lc", `bash "${script}"`], { env });
    } catch (err) {
      return resolve({ code: -1, error: String(err) });
    }
    child.stdout.on("data", (d) => send(d.toString()));
    child.stderr.on("data", (d) => send(d.toString()));
    child.on("error", (err) => resolve({ code: -1, error: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1 }));
  });
});

// ── 앱 버전 / 업데이트 확인(수동) / 외부 링크 ────────────────────────────
ipcMain.handle("app:version", () => app.getVersion());

ipcMain.handle("app:openExternal", (_e, url: string) => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  return true;
});

// 공개 릴리스의 최신 태그와 현재 버전 비교(수동 업데이트 안내용).
ipcMain.handle("app:checkUpdate", async () => {
  const current = app.getVersion();
  try {
    const r = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "PaperReader" },
    });
    if (!r.ok) {
      return { current, error: `릴리스를 찾을 수 없습니다 (${r.status}). 저장소/릴리스가 공개인지 확인하세요.` };
    }
    const data = (await r.json()) as { tag_name?: string; html_url?: string };
    const latest = (data.tag_name ?? "").replace(/^v/i, "");
    const url = data.html_url ?? `https://github.com/${RELEASES_REPO}/releases`;
    const hasUpdate = !!latest && cmpVersion(latest, current) > 0;
    return { current, latest, url, hasUpdate };
  } catch (err) {
    return { current, error: String(err) };
  }
});

// semver-lite 비교 (a>b → 1)
function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

app.whenReady().then(() => {
  // dev 에서 독 아이콘도 갈피로(패키징 앱은 번들 .icns 사용)
  if (isDev && process.platform === "darwin" && app.dock) {
    const img = nativeImage.createFromPath(devIconPath());
    if (!img.isEmpty()) app.dock.setIcon(img);
  }
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
