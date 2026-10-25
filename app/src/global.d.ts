import type { PaperAPI } from "../electron/preload";

declare global {
  interface Window {
    paperAPI: PaperAPI;
    galpiAutomaticPdf?: Promise<import("../electron/pdfExport").PdfExportRequest>;
  }
}

export {};
