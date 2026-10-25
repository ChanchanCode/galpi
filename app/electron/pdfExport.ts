import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { overlaySourcePdf } from "./pdfCompose";
import { docsRoot } from "./paths";
import { normalizePdfSettings, pdfGeometry, type PdfExportSettings } from "../src/export/pdfLayout";
import { bilingualPdfFilename, type CoverEvidence } from "../src/export/pdfFilename";
import type { PaperDocument } from "../src/types";
import { atomicWriteJson } from "./settings";
import { saveNewPdf } from "./pdfFiles";

interface PdfWorkerOptions {
  preloadPath?: string;
  loadWorker?: (win: BrowserWindow, docId: string) => Promise<unknown>;
}
let workerOptions: PdfWorkerOptions = {};
const automatic = new Map<string, { controller: AbortController; finished: Promise<void> }>();
export const automaticPdfDirectory = () => path.join(app.getPath("downloads"), "Galpi");
export function cancelAutomaticPdf(docId: string): void { automatic.get(docId)?.controller.abort(); }
export function waitForAutomaticPdf(docId: string): Promise<void> {
  return automatic.get(docId)?.finished ?? Promise.resolve();
}

export async function saveAutomaticPdf(docId: string): Promise<string> {
  validateDocId(docId);
  if (automatic.has(docId)) throw new Error("이미 PDF를 생성 중입니다.");
  const ctrl = new AbortController();
  let finish!: () => void;
  automatic.set(docId, { controller: ctrl, finished: new Promise<void>((resolve) => { finish = resolve; }) });
  let win: BrowserWindow | undefined;
  let savedPath: string | undefined;
  const onAbort = () => { if (win && !win.isDestroyed()) win.destroy(); };
  ctrl.signal.addEventListener("abort", onAbort);
  try {
    const docDir = path.join(docsRoot(), docId);
    // An interrupted summary after a successful export must not create another download.
    try {
      const prior = JSON.parse(await fs.readFile(path.join(docDir, "auto-pdf.json"), "utf8"));
      if (typeof prior.path === "string" && path.dirname(prior.path) === automaticPdfDirectory()) {
        await fs.access(prior.path);
        return prior.path;
      }
    } catch { /* First export, or the saved download was removed. */ }
    ctrl.signal.throwIfAborted();
    win = new BrowserWindow({ show: false, width: 1600, height: 1200,
      webPreferences: { preload: workerOptions.preloadPath ?? path.join(__dirname, "preload.cjs"),
        nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    if (workerOptions.loadWorker) await workerOptions.loadWorker(win, docId);
    else await win.loadFile(path.join(__dirname, "../dist/index.html"), { query: { autoPdf: docId } });
    const request: PdfExportRequest = await win.webContents.executeJavaScript(`Promise.race([
      window.galpiAutomaticPdf || Promise.reject(new Error('PDF 작업을 시작하지 못했습니다.')),
      new Promise((_, reject) => setTimeout(() => reject(new Error('PDF 준비 시간 초과')), 150000))
    ])`);
    if (request.docId !== docId) throw new Error("PDF 작업의 문서 ID가 일치하지 않습니다.");
    win.destroy();
    win = undefined;
    ctrl.signal.throwIfAborted();
    const bytes = await renderBilingualPdf(request, ctrl.signal);
    ctrl.signal.throwIfAborted();
    const doc: PaperDocument = JSON.parse(await fs.readFile(path.join(docDir, "document.json"), "utf8"));
    savedPath = await saveNewPdf(automaticPdfDirectory(), bilingualPdfFilename(doc, await filenameEvidence(doc, docDir)), bytes, ctrl.signal);
    ctrl.signal.throwIfAborted();
    await atomicWriteJson(path.join(docDir, "auto-pdf.json"), { path: savedPath, savedAt: new Date().toISOString() });
    return savedPath;
  } finally {
    ctrl.signal.removeEventListener("abort", onAbort);
    try {
      if (win && !win.isDestroyed()) win.destroy();
      if (ctrl.signal.aborted && savedPath) await fs.rm(savedPath, { force: true });
    } finally { automatic.delete(docId); finish(); }
  }
}

export interface PdfExportRequest {
  docId: string;
  html: string;
  pageMap: number[];
  settings: PdfExportSettings;
}

export interface PdfExportResult { path?: string; canceled?: boolean; error?: string }

function validateDocId(docId: unknown): asserts docId is string {
  if (typeof docId !== "string" || !docId || path.basename(docId) !== docId || docId === "." || docId === "..") {
    throw new Error("문서 ID가 올바르지 않습니다.");
  }
}

async function filenameEvidence(doc: PaperDocument, docDir: string): Promise<CoverEvidence> {
  let lines = doc.blocks.filter((b) => b.page === doc.pages[0]?.index && b.text).map((b) => b.text!);
  const text = doc.pages[0]?.text;
  if (text) {
    const fullPath = path.resolve(docDir, text);
    if (fullPath.startsWith(docDir + path.sep)) {
      try {
        const page = JSON.parse(await fs.readFile(fullPath, "utf8"));
        if (Array.isArray(page.lines)) lines = page.lines.map((l: { t?: string }) => l.t).filter((l: unknown): l is string => typeof l === "string");
      } catch { /* A missing original text layer falls back to extracted blocks. */ }
    }
  }
  const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const title = normalize(doc.title ?? "");
  const titleStart = lines.findIndex((line) => normalize(line).length >= 12 && title.includes(normalize(line)));
  const abstract = lines.findIndex((line) => /^(?:abstract|초록)\s*[:：]?$/i.test(line.trim()));
  return { headerLines: titleStart >= 0 ? lines.slice(0, titleStart) : [],
    coverLines: abstract >= 0 ? lines.slice(0, abstract) : lines.slice(0, 20), pageText: lines.join("\n") };
}

// The caller supplies a fully paginated, script-free snapshot of the preview.
export async function renderBilingualPdf(request: PdfExportRequest, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  validateDocId(request?.docId);
  if (typeof request.html !== "string" || !request.html.includes('data-pdf-ready="true"')
    || !Array.isArray(request.pageMap) || !request.pageMap.length || request.pageMap.length > 10000) {
    throw new Error("미리보기 준비가 끝난 뒤 저장해 주세요.");
  }
  const settings = normalizePdfSettings(request.settings);
  const docDir = path.join(docsRoot(), request.docId);
  const doc = JSON.parse(await fs.readFile(path.join(docDir, "document.json"), "utf8"));
  const sourcePath = path.resolve(docDir, doc.source_pdf);
  if (!sourcePath.startsWith(docDir + path.sep)) throw new Error("원문 PDF 경로가 올바르지 않습니다.");
  const source = await fs.readFile(sourcePath);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "galpi-pdf-"));
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const onAbort = () => { if (!win.isDestroyed()) win.destroy(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  // The snapshot embeds all fonts; it needs no files, network, or scripts.
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; font-src data:; img-src data:; script-src \'none\'">';
  const html = request.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi, "")
    .replace(/<head>/i, `<head>${csp}`);
  try {
    signal?.throwIfAborted();
    await fs.writeFile(path.join(temp, "print.html"), html, "utf8");
    await win.loadFile(path.join(temp, "print.html"));
    await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
    const g = pdfGeometry(settings);
    const translation = await win.webContents.printToPDF({
      printBackground: true, displayHeaderFooter: false, preferCSSPageSize: true,
      pageSize: { width: g.width / 72, height: g.height / 72 },
      margins: { top: 0, bottom: 0, left: 0, right: 0 }, scale: 1,
    });
    return await overlaySourcePdf(translation, source, request.pageMap, settings);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!win.isDestroyed()) win.destroy();
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export function registerPdfExport(options: PdfWorkerOptions = {}) {
  workerOptions = options;
  ipcMain.handle("export:revealAutoPdf", async (_event, docId: string) => {
    validateDocId(docId);
    const saved = JSON.parse(await fs.readFile(path.join(docsRoot(), docId, "auto-pdf.json"), "utf8"));
    if (typeof saved.path !== "string" || path.dirname(saved.path) !== automaticPdfDirectory()) return false;
    try { await fs.access(saved.path); } catch { return false; }
    shell.showItemInFolder(saved.path);
    return true;
  });
  let saving = false;
  ipcMain.handle("export:savePdf", async (event, request: PdfExportRequest): Promise<PdfExportResult> => {
    if (saving) return { error: "다른 PDF를 저장하고 있습니다. 잠시 기다려 주세요." };
    saving = true;
    try {
      validateDocId(request?.docId);
      const win = BrowserWindow.fromWebContents(event.sender);
      const docDir = path.join(docsRoot(), request.docId);
      const doc: PaperDocument = JSON.parse(await fs.readFile(path.join(docDir, "document.json"), "utf8"));
      const name = bilingualPdfFilename(doc, await filenameEvidence(doc, docDir));
      const options = { title: "원문 + 번역 PDF 저장", defaultPath: path.join(app.getPath("downloads"), name),
        filters: [{ name: "PDF", extensions: ["pdf"] }] };
      const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (res.canceled || !res.filePath) return { canceled: true };
      const bytes = await renderBilingualPdf(request);
      // Write a sibling temporary file, so a failed write leaves an existing destination intact.
      const pending = `${res.filePath}.${Date.now()}.tmp`;
      try {
        await fs.writeFile(pending, bytes);
        await fs.rename(pending, res.filePath);
      } finally { await fs.rm(pending, { force: true }); }
      shell.showItemInFolder(res.filePath);
      return { path: res.filePath };
    } catch (error) {
      return { error: `PDF 저장 실패: ${error instanceof Error ? error.message : String(error)}` };
    } finally { saving = false; }
  });
}
