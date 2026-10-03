// Preload — 렌더러에 안전한 API 표면만 노출 (contextIsolation).
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { PdfExportRequest, PdfExportResult } from "./pdfExport";
import type {
  AgyAccount,
  AgyQuotaView,
  AttachmentUpload,
  AutoJobStatus,
  ChatAttachment,
  ChatContextMode,
  ChatDelta,
  ChatModelList,
  ChatSendInput,
  ChatSendResult,
  ChatSession,
  ChatSessionMeta,
  PaperSummary,
  SummaryEvent,
  SummaryState,
} from "./ai/chatTypes";
export type * from "./ai/chatTypes";

export type DocSummary = {
  doc_id: string;
  title: string | null;
  authors: string | null;
  journal: string | null;
  page_count: number;
  state: "extracting" | "done" | "error";
  pages_done: number;
  finished: boolean;
  last_read_at: string | null;
};
export type UserFont = { name: string; dataUrl: string };

// ── AI (PLAN-AI §3) ──────────────────────────────────────────────────
export type AIProviderId = "gemini" | "openai" | "anthropic";
export type AIErrorKind =
  | "config" | "auth" | "rate_limit" | "server" | "network" | "parse" | "canceled" | "breaker";
export interface AIWireError { kind: AIErrorKind; message: string; status?: number; retryAfterMs?: number }
export interface TokenUsage { in: number; out: number; think: number; cache_read: number; cache_write: number }
export interface AIScope {
  kind: "selection" | "blocks" | "pages" | "section" | "doc";
  block_ids?: [string, string];
  n_blocks?: number;
  pages?: [number, number];
  section_id?: string;
}
export interface AIJob {
  jobId?: string;
  feature: string;                 // "translate.selection" 등 점 네임스페이스
  text: string;
  docId?: string;
  docTitle?: string;
  scope?: AIScope;
  model?: string;
  kind?: "para" | "title" | "footnote" | "list" | "formula" | "table" | "other";
}
export interface AIStreamResult {
  jobId?: string;
  text?: string;
  usage?: TokenUsage;
  estimated?: { in: number; out: number };
  error?: AIWireError;
}
export interface UsageAgg {
  calls: number; ok: number; fail: number;
  in: number; out: number; think: number; cache_read: number; cache_write: number;
  usd: number; ms: number;
}

export type AIBackendChoice = "auto" | "agy" | "rest";
export interface QuotaBucket {
  id: string; name?: string; description?: string;
  window?: string; remaining_fraction: number; reset_time?: string;
}
export interface QuotaState { buckets: QuotaBucket[]; at: number; error?: string }
export interface PoolStats { spares: number; spawning: number; failures: number; lastError: string }
export interface AgyProbe {
  bin: string | null; loggedIn: boolean; version?: string; reason?: string; buckets: QuotaBucket[];
}
export interface AIStatus {
  backend: { id: string; ready: boolean; provider: string; model: string; detail?: string };
  backendSetting: AIBackendChoice;
  provider: string;
  model: string;
  keys: Record<string, boolean>;
  breakers: Record<string, { trippedForMs: number; reason: string; consecutive: number; closedForSession: boolean }>;
  queue: { active: number; waiting: number; limit: number };
  running: string[];
  estimateBias: Record<string, number>;
  agy: { health: Omit<AgyProbe, "buckets"> & { checkedAt: number }; pool: PoolStats | null; quota: QuotaState };
}

export type AnchorMode = "full" | "prefix";
export interface TrSpan { start: number; end: number; ko: string }
export interface TrCacheEntry {
  ko: string; spans?: TrSpan[]; coverage?: number; model: string; ts: string; in: number; out: number;
}
export interface TrBlockInput { id: string; text: string; kind?: string; page?: number }
export interface TranslateDocOpts {
  docId: string; docTitle?: string; blocks: TrBlockInput[];
  anchorMode?: AnchorMode; force?: boolean;
  maxCharsPerBatch?: number; maxBlocksPerBatch?: number;
}
export interface TranslatedBlock {
  docId: string; id: string; ko: string; spans?: TrSpan[]; coverage?: number; fromCache: boolean;
}
export interface TranslatePlan {
  total: number; cached: number; pending: number; batches: number;
  est: { in: number; out: number };
  backend: string; model: string;
}
export interface TranslateProgress {
  docId: string;
  state: "running" | "done" | "canceled" | "error";
  total: number; cached: number; done: number; failed: number;
  usage: TokenUsage;
  est: { in: number; out: number };
  batches: { done: number; total: number };
  error?: { kind: string; message: string };
}

let jobSeq = 0;
function newJobId(): string {
  return `j_${Date.now().toString(36)}_${(jobSeq++).toString(36)}`;
}

const api = {
  listDocs: (): Promise<DocSummary[]> => ipcRenderer.invoke("docs:list"),
  loadDoc: (docId: string): Promise<unknown> => ipcRenderer.invoke("docs:load", docId),
  loadState: (docId: string): Promise<unknown> => ipcRenderer.invoke("state:load", docId),
  saveState: (docId: string, state: unknown): Promise<boolean> =>
    ipcRenderer.invoke("state:save", docId, state),
  // 라이브러리 정리(폴더/배정/이름) 메타 + 문서 삭제
  loadLibrary: (): Promise<{ folders: { id: string; name: string; parentId: string | null }[]; docs: Record<string, { folder?: string | null; title?: string }> }> =>
    ipcRenderer.invoke("library:load"),
  saveLibrary: (lib: unknown): Promise<boolean> => ipcRenderer.invoke("library:save", lib),
  deleteDoc: (docId: string): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke("docs:delete", docId),
  loadSettings: (): Promise<unknown> => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings: unknown): Promise<boolean> =>
    ipcRenderer.invoke("settings:save", settings),
  pickFonts: (): Promise<UserFont[]> => ipcRenderer.invoke("fonts:pick"),
  // 문서 자산 URL 빌더: paper://doc/<docId>/<상대경로>
  // docId 를 **호스트에 두지 않는다** — 표준 스킴이라 Chromium 이 한글 호스트를 퓨니코드(xn--)로 바꾸고
  // 63자 라벨 제한에도 걸린다. 한글 파일명 PDF 의 그림·지면·첨부가 깨진다.
  assetUrl: (docId: string, rel: string) =>
    `paper://doc/${encodeURIComponent(docId)}/${rel.split("/").map(encodeURIComponent).join("/")}`,
  // ── AI 스트리밍 ─────────────────────────────────────────────────
  // jobId 는 호출자가 미리 알 수 있어야 취소가 가능하다 → 여기서 만들어 넣고 그대로 돌려준다.
  newJobId,
  aiStream: (job: AIJob, onDelta: (delta: string) => void): Promise<AIStreamResult> => {
    const jobId = job.jobId ?? newJobId();
    const handler = (_e: unknown, payload: { jobId: string; delta: string }) => {
      if (payload?.jobId === jobId) onDelta(payload.delta);
    };
    ipcRenderer.on("ai:delta", handler);
    return ipcRenderer
      .invoke("ai:stream", { ...job, jobId })
      .then((r: AIStreamResult) => ({ jobId, ...r }))
      .finally(() => ipcRenderer.removeListener("ai:delta", handler)) as Promise<AIStreamResult>;
  },
  aiCancel: (jobId: string): Promise<boolean> => ipcRenderer.invoke("ai:cancel", jobId),
  aiEstimate: (job: AIJob): Promise<{ in: number; out: number; calls: number; backend: string; bias: Record<string, number> }> =>
    ipcRenderer.invoke("ai:estimate", job),
  // 자가 진단 — 백엔드·로그인·에이전트·풀·한도·차단기·큐를 한 번에.
  aiStatus: (): Promise<AIStatus> => ipcRenderer.invoke("ai:status"),
  setAIBackend: (backend: AIBackendChoice): Promise<boolean> => ipcRenderer.invoke("ai:setBackend", backend),
  // ── agy(Antigravity 구독) ──────────────────────────────────────
  agyProbe: (): Promise<AgyProbe> => ipcRenderer.invoke("agy:probe"),
  // 앱 안에서는 로그인이 불가능하다(인가 코드를 stdin 으로 못 넣는다) → 터미널을 열어 준다.
  agyOpenTerminal: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("agy:openTerminal"),
  agyQuota: (refresh?: boolean): Promise<QuotaState> => ipcRenderer.invoke("agy:quota", refresh),
  // kind="chat" 이면 채팅용 스페어(galpi-chat 에이전트 · --add-dir docs)를 데운다. model 생략 시 설정값.
  agyPrewarm: (kind?: "translate" | "chat", model?: string): Promise<PoolStats | null> =>
    ipcRenderer.invoke("agy:prewarm", kind, model),
  // 갈피가 만든 대화 db 만 지운다(사용자 본인 기록은 손대지 않는다). dryRun 으로 미리 셀 수 있다.
  agyGc: (dryRun?: boolean): Promise<{ removed: number; freedMb: number; remaining: number }> =>
    ipcRenderer.invoke("agy:gc", dryRun),
  agySetModel: (model: string): Promise<boolean> => ipcRenderer.invoke("agy:setModel", model),
  aiResetBreaker: (key?: string): Promise<boolean> => ipcRenderer.invoke("ai:resetBreaker", key),
  // API 키는 main 의 secrets.json(safeStorage)에만 있다. 렌더러는 "저장됨" 여부만 안다.
  setAIKey: (provider: AIProviderId, key: string): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke("ai:setKey", provider, key),
  aiKeyStatus: (): Promise<Record<string, boolean>> => ipcRenderer.invoke("ai:keyStatus"),
  // ── 문서 배치 번역 ─────────────────────────────────────────────
  // blocks 는 **뷰포트 우선 순서**로 넘긴다 — 위에서부터 채우면 읽던 화면이 밀린다.
  translateDoc: (opts: TranslateDocOpts): Promise<TranslateProgress> =>
    ipcRenderer.invoke("translate:doc", opts),
  cancelDocTranslation: (docId: string): Promise<boolean> =>
    ipcRenderer.invoke("translate:cancelDoc", docId),
  // 사전 견적 게이트(§8 단 1) — 모델을 부르지 않고 캐시 적중분·배치 수·토큰 견적만 받는다.
  translatePlan: (opts: TranslateDocOpts): Promise<TranslatePlan> =>
    ipcRenderer.invoke("translate:plan", opts),
  // 문서를 열자마자 이미 있는 번역을 즉시 칠하기 위함.
  cachedTranslations: (docId: string, blocks: { id: string; text: string }[]): Promise<Record<string, TrCacheEntry>> =>
    ipcRenderer.invoke("translate:cached", docId, blocks),
  isTranslating: (docId: string): Promise<boolean> => ipcRenderer.invoke("translate:isRunning", docId),
  onTranslateBlock: (cb: (b: TranslatedBlock) => void): (() => void) => {
    const h = (_e: unknown, b: TranslatedBlock) => cb(b);
    ipcRenderer.on("translate:block", h);
    return () => { ipcRenderer.removeListener("translate:block", h); };
  },
  onTranslateProgress: (cb: (p: TranslateProgress) => void): (() => void) => {
    const h = (_e: unknown, p: TranslateProgress) => cb(p);
    ipcRenderer.on("translate:progress", h);
    return () => { ipcRenderer.removeListener("translate:progress", h); };
  },
  // ── 사용량 원장 ────────────────────────────────────────────────
  usageSummary: (): Promise<{
    total: UsageAgg;
    today: UsageAgg;
    byFeature: Record<string, UsageAgg>;
    byDoc: Record<string, UsageAgg & { title: string; last: string }>;
    days: Record<string, UsageAgg>;
  }> => ipcRenderer.invoke("usage:summary"),
  usageForDoc: (docId: string): Promise<(UsageAgg & { title: string; last: string }) | null> =>
    ipcRenderer.invoke("usage:forDoc", docId),
  usageForJob: (jobId: string): Promise<UsageAgg | null> => ipcRenderer.invoke("usage:forJob", jobId),
  onUsageChanged: (cb: () => void): (() => void) => {
    const h = () => cb();
    ipcRenderer.on("usage:changed", h);
    return () => {
      ipcRenderer.removeListener("usage:changed", h);
    };
  },
  // 추출 진행/완료 라이브 통지 구독. 해제 함수 반환.
  onDocsChanged: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on("docs:changed", handler);
    return () => {
      ipcRenderer.removeListener("docs:changed", handler);
    };
  },
  // 드래그-드롭 PDF: File → 로컬 경로 (Electron webUtils), 그 경로로 추출 시작.
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  // docId 는 main 이 파일 해시로 미리 계산해 준다(extract.py make_doc_id 와 동일 규칙) — 자동 파이프라인 추적용.
  extractPdf: (pdfPath: string): Promise<{ started?: boolean; queued?: boolean; error?: string; docId?: string }> =>
    ipcRenderer.invoke("pipeline:extract", pdfPath),
  // PDF 파일 선택 다이얼로그 (⌘O) — 선택한 경로들 반환
  pickPdfs: (): Promise<string[]> => ipcRenderer.invoke("pdf:pick"),
  // 재추출 — 같은 doc_id 로 다시 추출(주석 보존)
  reextractDoc: (docId: string): Promise<{ started?: boolean; error?: string }> =>
    ipcRenderer.invoke("pipeline:reextract", docId),
  // 읽기 상태 부분 갱신 (완독 토글 / 최근 읽음 기록)
  updateReading: (docId: string, patch: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke("reading:update", docId, patch),
  // 배포: 추출 엔진 상태/지정 + 버전/업데이트 확인 + 외부 링크
  pipelineStatus: (): Promise<{
    python: string;
    scriptsDir: string;
    pythonOk: boolean;
    scriptOk: boolean;
    setupScript: string;
  }> => ipcRenderer.invoke("pipeline:status"),
  pickPython: (): Promise<{ canceled?: boolean; pythonPath?: string; pythonOk?: boolean }> =>
    ipcRenderer.invoke("pipeline:pickPython"),
  // AI 제공자 모델 목록 조회 — 키는 main 이 secrets 에서 읽는다(렌더러가 들고 있지 않다).
  listModels: (provider: AIProviderId): Promise<{ models?: string[]; error?: string }> =>
    ipcRenderer.invoke("ai:listModels", provider),
  // 원클릭 엔진 설치 + 진행 로그 구독
  installEngine: (): Promise<{ code: number; error?: string }> =>
    ipcRenderer.invoke("pipeline:install"),
  onInstallLog: (cb: (line: string) => void): (() => void) => {
    const h = (_e: unknown, line: string) => cb(line);
    ipcRenderer.on("pipeline:install-log", h);
    return () => ipcRenderer.removeListener("pipeline:install-log", h);
  },
  // 자립형 HTML 내보내기 — 완성 HTML 문자열을 저장 다이얼로그로 파일에 쓰기
  exportHtml: (html: string, filename: string): Promise<{ path?: string; canceled?: boolean }> =>
    ipcRenderer.invoke("export:saveHtml", html, filename),
  exportPdf: (request: PdfExportRequest): Promise<PdfExportResult> => ipcRenderer.invoke("export:savePdf", request),
  // ── AI 채팅 세션 (문서별 저장: docs/<id>/ai/chats/<sessionId>.json) ──────────
  chatList: (docId: string): Promise<ChatSessionMeta[]> => ipcRenderer.invoke("chat:list", docId),
  chatCreate: (docId: string, init?: { model?: string; context?: ChatContextMode; title?: string }): Promise<ChatSession> =>
    ipcRenderer.invoke("chat:create", docId, init),
  chatLoad: (docId: string, sessionId: string): Promise<ChatSession | null> =>
    ipcRenderer.invoke("chat:load", docId, sessionId),
  chatUpdate: (
    docId: string,
    sessionId: string,
    patch: { title?: string; model?: string; context?: ChatContextMode },
  ): Promise<ChatSessionMeta | null> => ipcRenderer.invoke("chat:update", docId, sessionId, patch),
  chatDelete: (docId: string, sessionId: string): Promise<boolean> => ipcRenderer.invoke("chat:delete", docId, sessionId),
  // 전송. 델타는 onDelta 로 흐르고, 끝나면 저장까지 마친 최종 메시지가 돌아온다.
  chatSend: (input: ChatSendInput, onDelta: (delta: string) => void): Promise<ChatSendResult> => {
    const handler = (_e: unknown, p: ChatDelta) => {
      if (p?.jobId === input.jobId) onDelta(p.delta);
    };
    ipcRenderer.on("chat:delta", handler);
    return (ipcRenderer.invoke("chat:send", input) as Promise<ChatSendResult>).finally(() =>
      ipcRenderer.removeListener("chat:delta", handler),
    );
  },
  chatCancel: (jobId: string): Promise<boolean> => ipcRenderer.invoke("chat:cancel", jobId),
  chatSaveAttachment: (up: AttachmentUpload): Promise<ChatAttachment | { error: string }> =>
    ipcRenderer.invoke("chat:saveAttachment", up),
  // 화면 영역 캡처 → 첨부. rect 는 창 기준 CSS px(= DIP). 호출 전 캡처 사각형 오버레이는 치워 둘 것.
  chatCapture: (
    docId: string,
    rect: { x: number; y: number; width: number; height: number },
    source?: { blockId?: string; page?: number },
  ): Promise<ChatAttachment | { error: string }> => ipcRenderer.invoke("chat:capture", docId, rect, source),
  // 문맥 칩 툴팁용 — 그 모드로 보낼 문맥의 글자수·토큰 견적. 모델 호출 없음.
  chatContextInfo: (docId: string, mode: ChatContextMode): Promise<{ chars: number; estTokens: number }> =>
    ipcRenderer.invoke("chat:contextInfo", docId, mode),
  // ── 핵심 요약 (docs/<id>/ai/summary.json) ─────────────────────────────
  summaryGet: (docId: string): Promise<PaperSummary | null> => ipcRenderer.invoke("summary:get", docId),
  summaryGenerate: (
    docId: string,
    opts?: { force?: boolean; model?: string },
  ): Promise<{ summary?: PaperSummary; error?: { kind: string; message: string } }> =>
    ipcRenderer.invoke("summary:generate", docId, opts),
  summaryState: (docId: string): Promise<SummaryState> => ipcRenderer.invoke("summary:state", docId),
  onSummaryChanged: (cb: (e: SummaryEvent) => void): (() => void) => {
    const h = (_e: unknown, p: SummaryEvent) => cb(p);
    ipcRenderer.on("summary:changed", h);
    return () => { ipcRenderer.removeListener("summary:changed", h); };
  },
  // ── 추가 시 자동 파이프라인 (추출 → 번역 → 요약) ─────────────────────────
  autoStatus: (): Promise<Record<string, AutoJobStatus>> => ipcRenderer.invoke("auto:status"),
  onAutoChanged: (cb: (s: Record<string, AutoJobStatus>) => void): (() => void) => {
    const h = (_e: unknown, p: Record<string, AutoJobStatus>) => cb(p);
    ipcRenderer.on("auto:changed", h);
    return () => { ipcRenderer.removeListener("auto:changed", h); };
  },
  // patch 없이 부르면 조회만. 기본값 둘 다 true.
  aiAuto: (patch?: { translate?: boolean; summary?: boolean }): Promise<{ translate: boolean; summary: boolean }> =>
    ipcRenderer.invoke("ai:auto", patch),
  // ── 모델 선택 ─────────────────────────────────────────────────────────
  chatModels: (refresh?: boolean): Promise<ChatModelList> => ipcRenderer.invoke("ai:chatModels", refresh),
  setChatModel: (id: string): Promise<boolean> => ipcRenderer.invoke("ai:setChatModel", id),
  // ── agy 계정 · 한도 (그냥 받아쓰기와 같은 계정 저장소) ─────────────────────
  agyAccounts: (): Promise<AgyAccount[]> => ipcRenderer.invoke("agy:accounts"),
  agySetAccount: (alias: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("agy:setAccount", alias),
  // 터미널을 열어 그 계정으로 로그인시킨다(새 별칭이면 폴더를 만든다).
  agyLogin: (alias: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("agy:login", alias),
  // 5분 캐시. refresh=true 면 강제 조회(키체인 프롬프트가 뜰 수 있다 — 사용자가 누를 때만).
  agyQuotaView: (refresh?: boolean): Promise<AgyQuotaView> => ipcRenderer.invoke("agy:quotaView", refresh),
  appVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),
  checkUpdate: (): Promise<{
    current: string;
    latest?: string;
    url?: string;
    hasUpdate?: boolean;
    error?: string;
  }> => ipcRenderer.invoke("app:checkUpdate"),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke("app:openExternal", url),
  // 새 버전 받아 교체 준비 → 재시작/나중에(종료 시 적용) 대화상자. 패키징 앱에서만 실제 교체.
  installUpdate: (): Promise<{ state: "latest" | "ready" | "manual" | "error"; latest?: string; current: string; error?: string }> =>
    ipcRenderer.invoke("app:installUpdate"),
};

contextBridge.exposeInMainWorld("paperAPI", api);

export type PaperAPI = typeof api;
