// Electron main process — 파일 IO, 메뉴, 문서 데이터 접근 (명세 §12, §10).
// 경로는 app.getPath('userData') 로 OS-중립 (macOS/Windows 양쪽 동작).
import { app, BrowserWindow, ipcMain, protocol, dialog, net } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

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
ipcMain.handle("docs:list", async () => {
  const root = docsRoot();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const docs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const raw = await fs.readFile(path.join(root, e.name, "document.json"), "utf8");
        const doc = JSON.parse(raw);
        docs.push({ doc_id: e.name, title: doc.title, page_count: doc.page_count });
      } catch {
        /* document.json 없는 폴더는 건너뜀 */
      }
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

app.whenReady().then(() => {
  registerDocProtocol();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
