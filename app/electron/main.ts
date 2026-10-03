// Electron main process — 파일 IO, 메뉴, 문서 데이터 접근 (명세 §12, §10).
// 경로는 app.getPath('userData') 로 OS-중립 (macOS/Windows 양쪽 동작).
import { app, BrowserWindow, ipcMain, protocol, dialog, net, shell, nativeImage } from "electron";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { watch, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { appSupportDir, docsRoot } from "./paths";
import { migratePlaintextKeys, patchSettings, readSettings, saveSettings } from "./settings";
import { registerAIService } from "./ai/service";
import { disposePool } from "./ai/agyBackend";
import { checkAndApply, fetchLatestRelease } from "./updater";
import { registerChatService } from "./ai/chat";
import { docDirOf, registerSummaryService } from "./ai/summary";
import { autoOnDeleted, autoOnExit, autoOnQueued, docIdForPdf, registerAutoPipeline } from "./ai/autoPipeline";
import { loadLedger } from "./usage";
import { registerPdfExport } from "./pdfExport";

const isDev = !app.isPackaged;

// dev 전용 CDP 포트 — 개발 중 렌더러를 스크립트로 붙잡아 검증하기 위해서다.
// 패키징 앱에는 절대 안 붙는다(isPackaged 가드).
if (isDev) app.commandLine.appendSwitch("remote-debugging-port", "9222");

// 앱 이름 — dev 에서 메뉴/독이 "Electron" 으로 뜨지 않게(패키징은 productName 적용).
app.setName("갈피");

// dev 용 아이콘 PNG 경로(빌드 리소스). 패키징 앱은 번들 아이콘(.icns)을 씀.
function devIconPath(): string {
  return path.join(__dirname, "../build/icon.png");
}

// 배포용: 친구가 공개 릴리스에서 업데이트를 받아볼 GitHub 저장소.

// 데이터 폴더 경로(appSupportDir / settingsPath / docsRoot)는 ./paths 에 모아 두었다.

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
  const s = await readSettings();
  if (s.pythonPath && existsSync(s.pythonPath)) return s.pythonPath;
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
  return win;
}

// ── 문서 자산(이미지 등) 보안 프로토콜 ────────────────────────────────
// 렌더러는 paper://<doc_id>/<상대경로> 로 페이지 PNG/asset 을 로드한다.
// docsRoot 밖 접근은 차단.
function registerDocProtocol() {
  protocol.handle("paper", async (request) => {
    const url = new URL(request.url);
    // 새 형식 paper://doc/<docId>/<rel> (docId 는 경로 첫 조각). 옛 형식 paper://<docId>/<rel> 도 받는다.
    let docId: string;
    let rel: string;
    try {
      const segs = url.pathname.replace(/^\/+/, "").split("/");
      if (url.hostname === "doc") {
        docId = decodeURIComponent(segs.shift() ?? "");
        rel = segs.map(decodeURIComponent).join("/");
      } else {
        docId = url.hostname;
        rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      }
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const target = path.normalize(path.join(docsRoot(), docId, rel));
    if (!docId || !target.startsWith(docsRoot() + path.sep)) {
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

// 자립형 HTML 내보내기 — 렌더러가 완성한 HTML 문자열을 저장 다이얼로그로 파일에 쓴다.
// (AirDrop 으로 아이패드에 보내 Safari 로 읽기 위함. 포커스 기능 포함.)
ipcMain.handle("export:saveHtml", async (_e, html: string, filename: string) => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const defaultPath = path.join(app.getPath("downloads"), filename);
  const res = await dialog.showSaveDialog(win ?? undefined!, {
    title: "HTML로 내보내기",
    defaultPath,
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  await fs.writeFile(res.filePath, html, "utf8");
  void shell.showItemInFolder(res.filePath); // Finder 에 보여줘 AirDrop 하기 쉽게
  return { path: res.filePath };
});

// ── 라이브러리 정리 (폴더 트리 + 문서 폴더배정/이름변경) ─────────────────
// library.json: { folders: [{id,name,parentId}], docs: { [docId]: {folder, title} } }
function libraryPath(): string {
  return path.join(appSupportDir(), "library.json");
}
ipcMain.handle("library:load", async () => {
  const lib = (await readJson(libraryPath())) as any;
  return lib && typeof lib === "object" && Array.isArray(lib.folders)
    ? { folders: lib.folders, docs: lib.docs ?? {} }
    : { folders: [], docs: {} };
});
ipcMain.handle("library:save", async (_e, lib: unknown) => {
  await fs.mkdir(appSupportDir(), { recursive: true });
  await fs.writeFile(libraryPath(), JSON.stringify(lib, null, 2), "utf8");
  return true;
});
// 문서 영구 삭제 — docs/<docId> 폴더 제거. id 검증으로 경로 탈출 차단.
// (문서 id 는 파일명의 한글 등 유니코드 글자를 그대로 쓴다 — ASCII 만 받으면 한글 이름 PDF 를 못 지운다.)
ipcMain.handle("docs:delete", async (_e, docId: string) => {
  const dir = docDirOf(docId);
  if (!dir) {
    return { error: "잘못된 문서 ID" };
  }
  autoOnDeleted(docId); // 자동 번역·요약 대기열에서 빼고, 도는 중이면 끊는다
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { error: String(err) };
  }
});

// 전역 설정 (§10) — 기본 타이포·폰트·단축키.
// 저장은 **부분 병합 + 원자적 쓰기**(H2). 렌더러가 자기 소유 키만 보내도
// main 이 쓴 pythonPath 같은 값이 살아남고, 쓰기 도중 크래시해도 반쪽 파일이 안 남는다.
ipcMain.handle("settings:load", async () => {
  const s = await readSettings();
  return Object.keys(s).length ? s : null;
});

ipcMain.handle("settings:save", async (_e, settings: unknown) => {
  if (!settings || typeof settings !== "object") return false;
  await saveSettings(settings as Record<string, unknown>);
  return true;
});

// PDF 파일 선택 (⌘O) — 반환된 경로로 렌더러가 드래그-드롭과 동일하게 추출 시작.
ipcMain.handle("pdf:pick", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  return res.canceled ? [] : res.filePaths;
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

// ── 고아 추출 상태 복구 ─────────────────────────────────────────────
// 추출 도중 앱이 종료되면 status.json 이 {"state":"extracting"} 에 고착된다.
// 시작 시 한 번 훑어, 실제로 진행 중이 아닌 문서를 "error" 로 바꿔
// 라이브러리 우클릭 '다시 추출'로 복구할 수 있게 한다.
async function sweepStaleExtracting(): Promise<void> {
  const root = docsRoot();
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (extractActive || extractQueue.some((j) => j.docId === e.name || j.newDocId === e.name)) continue;
    const file = path.join(root, e.name, "status.json");
    const status = await readJson(file);
    if (status?.state !== "extracting") continue;
    try {
      await fs.writeFile(file, JSON.stringify({ ...status, state: "error" }), "utf8");
    } catch {
      /* 개별 실패는 무시 — 다음 실행에서 다시 시도됨 */
    }
  }
}

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

// ── PDF 추출: extract.py 를 자식 프로세스로 실행 — '직렬 큐'(동시 1개) ────────
// 여러 PDF 를 한꺼번에 끌어다 놔도 한 번에 하나씩만 처리한다(메모리 폭주·먹통 방지).
// 추출은 document.json/status.json 을 점진 기록 → 와처가 라이브러리를 자동 갱신.
// docId = 재추출(--doc-id 로 기존 폴더 유지). isNew = 새 PDF 추가 — 끝나면 자동 번역·요약(newDocId 는 미리 계산한 id).
interface ExtractJob { pdfPath: string; py: string; scriptsDir: string; script: string; docId?: string; isNew: boolean; newDocId?: string }
const extractQueue: ExtractJob[] = [];
let extractActive = false;

// MinerU 의 BLAS/OMP 스레드를 코어 절반으로 제한 → 추출 중에도 컴퓨터가 멈추지 않게.
function extractEnv(): NodeJS.ProcessEnv {
  const n = String(Math.max(1, Math.floor(os.cpus().length / 2)));
  return {
    ...process.env,
    OMP_NUM_THREADS: n,
    MKL_NUM_THREADS: n,
    OPENBLAS_NUM_THREADS: n,
    NUMEXPR_NUM_THREADS: n,
    VECLIB_MAXIMUM_THREADS: n,
    TOKENIZERS_PARALLELISM: "false",
  };
}

function runNextExtract(): void {
  if (extractActive) return;
  const job = extractQueue.shift();
  if (!job) return;
  extractActive = true;
  const env = extractEnv();
  // 우선순위를 낮춰(nice) 다른 앱이 멈추지 않게. (mac/linux; win 은 그대로)
  const useNice = process.platform !== "win32";
  const cmd = useNice ? "nice" : job.py;
  const args = useNice ? ["-n", "15", job.py, job.script, job.pdfPath] : [job.script, job.pdfPath];
  if (job.docId) args.push("--doc-id", job.docId); // 재추출: 기존 문서 폴더 유지
  const notifyAuto = (code: number | null) => {
    if (job.isNew && job.newDocId) autoOnExit(job.newDocId, code);
  };
  let child;
  try {
    child = spawn(cmd, args, { cwd: job.scriptsDir, stdio: "ignore", env });
  } catch {
    extractActive = false;
    notifyAuto(-1);
    setTimeout(runNextExtract, 200);
    return;
  }
  let settled = false;
  const done = (code: number | null) => {
    if (settled) return;
    settled = true;
    extractActive = false;
    notifyAuto(code);
    setTimeout(runNextExtract, 500); // 다음 작업 전 잠깐 — 메모리 회수 여유
  };
  child.on("error", () => done(-1));
  child.on("close", (code) => done(code));
}

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
  // extract.py 와 같은 규칙으로 id 를 미리 계산 — 자동 파이프라인·라이브러리 카드가 추출 전부터 문서를 가리킨다.
  // 못 읽는 파일이면 extract.py 도 실패하므로 여기서 막지 않는다(오류는 status.json 경로로 보인다).
  const docId = await docIdForPdf(pdfPath).catch(() => undefined);
  const dup = extractQueue.find((j) => j.pdfPath === pdfPath);
  if (dup) {
    return { started: true, queued: true, docId: dup.newDocId ?? docId }; // 이미 대기 중인 같은 파일
  }
  const position = extractActive || extractQueue.length > 0 ? extractQueue.length + 1 : 0;
  extractQueue.push({ pdfPath, py, scriptsDir, script, isNew: true, newDocId: docId });
  if (docId) autoOnQueued(docId);
  runNextExtract();
  return { started: true, queued: position > 0, position, docId };
});

// 재추출 — 문서 폴더의 source.pdf 로 같은 doc_id 에 다시 추출(주석·읽기상태는 state.json 이라 보존).
ipcMain.handle("pipeline:reextract", async (_e, docId: string) => {
  const src = path.join(docsRoot(), docId, "source.pdf");
  if (!existsSync(src)) return { error: "원본 PDF(source.pdf)가 없어 재추출할 수 없습니다." };
  const py = await resolvePython();
  const scriptsDir = pipelineScriptsDir();
  const script = path.join(scriptsDir, "extract.py");
  if (!existsSync(py)) return { error: "추출 엔진이 설치되지 않았습니다." };
  if (!existsSync(script)) return { error: `extract.py 없음: ${script}` };
  if (extractQueue.some((j) => j.docId === docId)) return { started: true, queued: true };
  extractQueue.push({ pdfPath: src, py, scriptsDir, script, docId, isNew: false });
  runNextExtract();
  return { started: true };
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
  await patchSettings("pythonPath", pythonPath);
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

// 공개 릴리스의 최신 태그/에셋 조회. 수동 확인(설정)·실행 시 자동 확인 양쪽에서 재사용.
// 업데이트 확인·자동 적용은 updater.ts (zip 받아 번들 교체 → 재시작 · 나중에면 종료 시 적용).
ipcMain.handle("app:checkUpdate", fetchLatestRelease);
ipcMain.handle("app:installUpdate", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win ? checkAndApply(win, true, disposePool) : { state: "error", current: app.getVersion(), error: "창 없음" };
});

app.whenReady().then(async () => {
  // dev 에서 독 아이콘도 갈피로(패키징 앱은 번들 .icns 사용)
  if (isDev && process.platform === "darwin" && app.dock) {
    const img = nativeImage.createFromPath(devIconPath());
    if (!img.isEmpty()) app.dock.setIcon(img);
  }
  await migratePlaintextKeys(); // settings.json 의 평문 API 키 → secrets.json (최초 1회)
  await loadLedger(); // 사용량 원장을 인메모리 집계로 (§4.1)
  registerAIService();
  registerChatService();
  registerSummaryService();
  registerPdfExport();
  registerAutoPipeline(); // 지난 실행에서 끝나지 않은 자동 번역·요약을 잠시 뒤 이어서 돈다
  registerDocProtocol();
  const win = createWindow();
  await sweepStaleExtracting(); // 지난 실행에서 고착된 '추출 중' 문서 → error 로 복구 가능하게
  startDocsWatcher();
  // 실행할 때마다 업데이트 확인(패키징 빌드만; dev 제외). UI 가 먼저 뜨도록 잠시 뒤.
  if (!isDev) setTimeout(() => void checkAndApply(win, false, disposePool), 2500);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 종료 시 agy 웜 스페어(번역·채팅 풀)를 바로 정리 — 파이프가 닫히길 기다리며 고아 프로세스로 남지 않게.
app.on("before-quit", () => disposePool());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
