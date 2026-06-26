// Preload — 렌더러에 안전한 API 표면만 노출 (contextIsolation).
import { contextBridge, ipcRenderer } from "electron";

export type DocSummary = {
  doc_id: string;
  title: string | null;
  page_count: number;
  state: "extracting" | "done" | "error";
  pages_done: number;
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
};

contextBridge.exposeInMainWorld("paperAPI", api);

export type PaperAPI = typeof api;
