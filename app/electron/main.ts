// Electron main process — 파일 IO, 메뉴, 문서 데이터 접근 (명세 §12, §10).
// 경로는 app.getPath('userData') 로 OS-중립 (macOS/Windows 양쪽 동작).
import { app, BrowserWindow, ipcMain, protocol, dialog, net, shell, nativeImage } from "electron";
import path from "node:path";
import os from "node:os";
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

// 데이터 폴더: ~/Library/Application Support/Galpi (구버전은 PaperReader → 최초 실행 시 이전).
const DATA_DIR_NAME = "Galpi";
const LEGACY_DATA_DIR_NAME = "PaperReader";
function appSupportDir(): string {
  return path.join(app.getPath("appData"), DATA_DIR_NAME);
}
function legacyAppSupportDir(): string {
  return path.join(app.getPath("appData"), LEGACY_DATA_DIR_NAME);
}
function settingsPath(): string {
  return path.join(appSupportDir(), "settings.json");
}

// 구 데이터 폴더(PaperReader)를 새 폴더(Galpi)로 한 번만 이전(문서·설정·라이브러리·pyenv 통째 이동).
async function migrateLegacyDataDir(): Promise<void> {
  const cur = appSupportDir();
  const legacy = legacyAppSupportDir();
  if (existsSync(cur) || !existsSync(legacy)) return; // 이미 이전됐거나 구 폴더 없음
  try {
    await fs.rename(legacy, cur);
    console.log(`[migrate] ${legacy} → ${cur}`);
  } catch (err) {
    console.warn("[migrate] 데이터 폴더 이전 실패(무시):", err);
  }
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
  const legacy = path.join(legacyAppSupportDir(), "pyenv", "bin", "python"); // 이전 전 구버전 호환
  if (existsSync(legacy)) return legacy;
  const dev = path.resolve(__dirname, "../../pipeline/.venv/bin/python");
  if (existsSync(dev)) return dev;
  return def; // 없으면 기본 경로 반환(상태/에러 메시지에 표시)
}

// paper:// 를 표준·보안 스킴으로 등록 (net.fetch/이미지 로딩 허용). app ready 이전 필수.
protocol.registerSchemesAsPrivileged([
  { scheme: "paper", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// 추출 파이프라인과 공유하는 문서 루트.
// macOS: ~/Library/Application Support/Galpi/docs
function docsRoot(): string {
  // pipeline/extract.py 의 default_output_root() 와 동일 위치(<appData>/Galpi/docs).
  return path.join(appSupportDir(), "docs");
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
  return win;
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
ipcMain.handle("docs:delete", async (_e, docId: string) => {
  if (!/^[A-Za-z0-9._-]+$/.test(docId) || docId === "." || docId === "..") {
    return { error: "잘못된 문서 ID" };
  }
  try {
    await fs.rm(path.join(docsRoot(), docId), { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { error: String(err) };
  }
});

// 전역 설정 (§10) — 기본 타이포·폰트·단축키.
ipcMain.handle("settings:load", async () => {
  const file = settingsPath();
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
});

ipcMain.handle("settings:save", async (_e, settings: unknown) => {
  const dir = appSupportDir();
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

// ── 멀티 제공자 AI (Gemini / OpenAI / Anthropic) ─────────────────────────
type AIProvider = "gemini" | "openai" | "anthropic";
const TRANSLATE_SYS = TRANSLATE_PROMPT.replace(/\n\nText:\n$/, "");

// settings.ai → {provider, model, key}. 레거시 settings.translation 도 흡수.
function resolveAI(s: any): { provider: AIProvider; model: string; key: string } {
  const ai = s?.ai;
  if (ai?.provider) {
    const provider = ai.provider as AIProvider;
    let model = (ai.models?.[provider] ?? "").trim();
    if (provider === "gemini" && (!model || model === "gemini-2.0-flash")) model = "gemini-2.5-flash-lite";
    return { provider, model, key: (ai.keys?.[provider] ?? "").trim() };
  }
  const t = s?.translation;
  const saved = t?.model?.trim();
  const model = !saved || saved === "gemini-2.0-flash" ? "gemini-2.5-flash-lite" : saved;
  return { provider: "gemini", model, key: (t?.apiKey ?? "").trim() };
}

// SSE data 라인 리더(제공자 공통)
async function readSSE(body: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) onData(line.slice(5).trim());
    }
  }
}

interface StreamResult {
  full: string;
  error?: string;
  status?: number;
}

async function streamProvider(
  provider: AIProvider,
  key: string,
  model: string,
  text: string,
  send: (t: string) => void,
): Promise<StreamResult> {
  let r: Response;
  if (provider === "gemini") {
    r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: TRANSLATE_SYS }] },
          contents: [{ parts: [{ text }] }],
          // thinking 끄기 → 2.5 모델 지연 대폭 감소
          generationConfig: { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
        }),
      },
    );
  } else if (provider === "openai") {
    r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: 0.2,
        messages: [
          { role: "system", content: TRANSLATE_SYS },
          { role: "user", content: text },
        ],
      }),
    });
  } else {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        temperature: 0.2,
        stream: true,
        system: TRANSLATE_SYS,
        messages: [{ role: "user", content: text }],
      }),
    });
  }
  if (!r.ok || !r.body) {
    const b = await r.text().catch(() => "");
    return { full: "", error: `${provider} API 오류 ${r.status}: ${b.slice(0, 200)}`, status: r.status };
  }
  let full = "";
  await readSSE(r.body, (d) => {
    if (!d || d === "[DONE]") return;
    try {
      const j = JSON.parse(d) as any;
      let t = "";
      if (provider === "gemini") t = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
      else if (provider === "openai") t = j.choices?.[0]?.delta?.content ?? "";
      else if (j.type === "content_block_delta" && j.delta?.type === "text_delta") t = j.delta.text ?? "";
      if (t) {
        full += t;
        send(t);
      }
    } catch {
      /* keepalive/부분 라인 무시 */
    }
  });
  return { full };
}

// 스트리밍 번역 — 제공자별 SSE → 조각 즉시 전송. 일시 오류(429/503/500/529)는 1회 재시도.
ipcMain.handle("translate:stream", async (e, text: string, reqId: number) => {
  const s = await readJson(settingsPath());
  const { provider, model, key } = resolveAI(s);
  if (!key) return { error: `${provider.toUpperCase()} API 키가 없습니다. 설정 → AI 에서 입력하세요.` };
  if (!model) return { error: "모델을 선택하세요 (설정 → AI)." };
  const send = (delta: string) => {
    if (!e.sender.isDestroyed()) e.sender.send("translate:delta", { id: reqId, delta });
  };
  try {
    let res = await streamProvider(provider, key, model, text, send);
    if (res.error && res.full === "" && res.status && [429, 500, 503, 529].includes(res.status)) {
      await new Promise((r) => setTimeout(r, 900)); // 과부하 일시 오류 → 잠깐 쉬고 1회 재시도
      res = await streamProvider(provider, key, model, text, send);
    }
    return res.error ? { error: res.error } : { translation: res.full.trim() };
  } catch (err) {
    return { error: String(err) };
  }
});

// 제공자별 모델 목록 조회 (키로 직접 API 호출)
ipcMain.handle("ai:listModels", async (_e, provider: AIProvider, key: string) => {
  const k = (key ?? "").trim();
  if (!k) return { error: "키를 먼저 입력하세요." };
  try {
    if (provider === "gemini") {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${k}`);
      if (!r.ok) return { error: `오류 ${r.status}` };
      const j = (await r.json()) as any;
      const models = (j.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m: any) => String(m.name ?? "").replace(/^models\//, ""))
        .filter(Boolean);
      return { models };
    }
    if (provider === "openai") {
      const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${k}` } });
      if (!r.ok) return { error: `오류 ${r.status}` };
      const j = (await r.json()) as any;
      const models = (j.data ?? [])
        .map((m: any) => m.id as string)
        .filter((id: string) => /^(gpt|o\d|chatgpt)/i.test(id))
        .sort();
      return { models };
    }
    const r = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: { "x-api-key": k, "anthropic-version": "2023-06-01" },
    });
    if (!r.ok) return { error: `오류 ${r.status}` };
    const j = (await r.json()) as any;
    const models = (j.data ?? []).map((m: any) => m.id as string).filter(Boolean);
    return { models };
  } catch (err) {
    return { error: String(err) };
  }
});

// ── PDF 추출: extract.py 를 자식 프로세스로 실행 — '직렬 큐'(동시 1개) ────────
// 여러 PDF 를 한꺼번에 끌어다 놔도 한 번에 하나씩만 처리한다(메모리 폭주·먹통 방지).
// 추출은 document.json/status.json 을 점진 기록 → 와처가 라이브러리를 자동 갱신.
interface ExtractJob { pdfPath: string; py: string; scriptsDir: string; script: string }
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
  let child;
  try {
    child = spawn(cmd, args, { cwd: job.scriptsDir, stdio: "ignore", env });
  } catch {
    extractActive = false;
    setTimeout(runNextExtract, 200);
    return;
  }
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    extractActive = false;
    setTimeout(runNextExtract, 500); // 다음 작업 전 잠깐 — 메모리 회수 여유
  };
  child.on("error", done);
  child.on("close", done);
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
  if (extractQueue.some((j) => j.pdfPath === pdfPath)) {
    return { started: true, queued: true }; // 이미 대기 중인 같은 파일
  }
  const position = extractActive || extractQueue.length > 0 ? extractQueue.length + 1 : 0;
  extractQueue.push({ pdfPath, py, scriptsDir, script });
  runNextExtract();
  return { started: true, queued: position > 0, position };
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

// 공개 릴리스의 최신 태그/에셋 조회. 수동 확인(설정)·실행 시 자동 확인 양쪽에서 재사용.
interface ReleaseInfo {
  current: string;
  latest?: string;
  url?: string; // 릴리스 페이지
  dmgUrl?: string; // .dmg 에셋 직접 다운로드 URL
  hasUpdate?: boolean;
  error?: string;
}
async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const current = app.getVersion();
  try {
    const r = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Galpi" },
    });
    if (!r.ok) {
      return { current, error: `릴리스를 찾을 수 없습니다 (${r.status}). 저장소/릴리스가 공개인지 확인하세요.` };
    }
    const data = (await r.json()) as {
      tag_name?: string;
      html_url?: string;
      assets?: { name: string; browser_download_url: string }[];
    };
    const latest = (data.tag_name ?? "").replace(/^v/i, "");
    const url = data.html_url ?? `https://github.com/${RELEASES_REPO}/releases`;
    const dmgUrl = (data.assets ?? []).find((a) => /\.dmg$/i.test(a.name))?.browser_download_url;
    const hasUpdate = !!latest && cmpVersion(latest, current) > 0;
    return { current, latest, url, dmgUrl, hasUpdate };
  } catch (err) {
    return { current, error: String(err) };
  }
}
ipcMain.handle("app:checkUpdate", fetchLatestRelease);

// .dmg 를 다운로드 폴더로 받아 경로 반환.
async function downloadDmg(url: string): Promise<string> {
  const name = url.split("/").pop() || "Galpi-update.dmg";
  const dest = path.join(app.getPath("downloads"), name);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status})`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

// 실행 시 자동 업데이트 확인 → 있으면 받아서 dmg 를 열어 교체 안내.
// (코드 서명이 없어 조용한 자동설치는 불가 → 받은 dmg 에서 앱을 드래그해 덮어쓰는 방식.)
let launchUpdateChecked = false;
async function checkUpdateOnLaunch(win: BrowserWindow) {
  if (launchUpdateChecked) return;
  launchUpdateChecked = true;
  let info: ReleaseInfo;
  try {
    info = await fetchLatestRelease();
  } catch {
    return; // 네트워크 실패는 조용히 무시(실행 방해 금지)
  }
  if (!info.hasUpdate || !info.latest || win.isDestroyed()) return;
  const { response } = await dialog.showMessageBox(win, {
    type: "info",
    buttons: ["지금 업데이트", "나중에"],
    defaultId: 0,
    cancelId: 1,
    message: `새 버전 v${info.latest} 이(가) 있습니다.`,
    detail: `현재 버전은 v${info.current} 입니다. 지금 받아서 설치할까요?`,
  });
  if (response !== 0) return;
  try {
    if (!info.dmgUrl) throw new Error("dmg 에셋을 찾을 수 없습니다.");
    const dmg = await downloadDmg(info.dmgUrl);
    await shell.openPath(dmg); // dmg 마운트 → Finder 창
    if (!win.isDestroyed()) {
      await dialog.showMessageBox(win, {
        type: "info",
        buttons: ["확인"],
        message: "새 버전을 받았습니다.",
        detail: "열린 디스크 이미지(갈피)에서 앱을 ‘응용 프로그램’ 폴더로 드래그해 덮어쓴 뒤, 갈피를 다시 실행하세요.",
      });
    }
  } catch {
    if (info.url) void shell.openExternal(info.url); // 실패 시 릴리스 페이지로 폴백
  }
}

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

app.whenReady().then(async () => {
  // dev 에서 독 아이콘도 갈피로(패키징 앱은 번들 .icns 사용)
  if (isDev && process.platform === "darwin" && app.dock) {
    const img = nativeImage.createFromPath(devIconPath());
    if (!img.isEmpty()) app.dock.setIcon(img);
  }
  await migrateLegacyDataDir(); // 구 PaperReader 폴더 → Galpi (최초 1회)
  registerDocProtocol();
  const win = createWindow();
  startDocsWatcher();
  // 실행할 때마다 업데이트 확인(패키징 빌드만; dev 제외). UI 가 먼저 뜨도록 잠시 뒤.
  if (!isDev) setTimeout(() => void checkUpdateOnLaunch(win), 2500);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
