// Preload — 렌더러에 안전한 API 표면만 노출 (contextIsolation).
import { contextBridge, ipcRenderer, webUtils } from "electron";

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

const api = {
  listDocs: (): Promise<DocSummary[]> => ipcRenderer.invoke("docs:list"),
  loadDoc: (docId: string): Promise<unknown> => ipcRenderer.invoke("docs:load", docId),
  loadState: (docId: string): Promise<unknown> => ipcRenderer.invoke("state:load", docId),
  saveState: (docId: string, state: unknown): Promise<boolean> =>
    ipcRenderer.invoke("state:save", docId, state),
  loadSettings: (): Promise<unknown> => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings: unknown): Promise<boolean> =>
    ipcRenderer.invoke("settings:save", settings),
  pickFonts: (): Promise<UserFont[]> => ipcRenderer.invoke("fonts:pick"),
  // 문서 자산 URL 빌더: paper://<docId>/<상대경로>
  assetUrl: (docId: string, rel: string) => `paper://${docId}/${rel}`,
  // 로컬 번역 (NLLB, 오프라인)
  translate: (text: string, src = "en", tgt = "ko"): Promise<{ translation?: string; error?: string }> =>
    ipcRenderer.invoke("translate:text", text, src, tgt),
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
  extractPdf: (pdfPath: string): Promise<{ started?: boolean; error?: string }> =>
    ipcRenderer.invoke("pipeline:extract", pdfPath),
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
  // 원클릭 엔진 설치 + 진행 로그 구독
  installEngine: (): Promise<{ code: number; error?: string }> =>
    ipcRenderer.invoke("pipeline:install"),
  onInstallLog: (cb: (line: string) => void): (() => void) => {
    const h = (_e: unknown, line: string) => cb(line);
    ipcRenderer.on("pipeline:install-log", h);
    return () => ipcRenderer.removeListener("pipeline:install-log", h);
  },
  appVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),
  checkUpdate: (): Promise<{
    current: string;
    latest?: string;
    url?: string;
    hasUpdate?: boolean;
    error?: string;
  }> => ipcRenderer.invoke("app:checkUpdate"),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke("app:openExternal", url),
};

contextBridge.exposeInMainWorld("paperAPI", api);

export type PaperAPI = typeof api;
