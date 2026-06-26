import type { PaperAPI } from "../electron/preload";

declare global {
  interface Window {
    paperAPI: PaperAPI;
  }
}

export {};
