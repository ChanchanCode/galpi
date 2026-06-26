// Preload — 렌더러에 안전한 API 표면만 노출 (contextIsolation).
import { contextBridge, ipcRenderer } from "electron";

export type DocSummary = { doc_id: string; title: string | null; page_count: number };
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
};

contextBridge.exposeInMainWorld("paperAPI", api);

export type PaperAPI = typeof api;
