import type { PaperDocument } from "../types";
import type { PdfExportRequest } from "../../electron/pdfExport";
import type { UserFont } from "../../electron/preload";
import { buildFootnotes } from "../render/footnotes";
import { buildFrontMatter } from "../render/frontmatter";
import { buildPageMerges } from "../render/pagemerge";
import { collectTrBlocks } from "../translate/trBlocks";
import { translatedText } from "../translate/translationContent";
import { registerFonts } from "../store/useStore";
import { DEFAULT_TYPOGRAPHY, type Typography } from "../store/typography";
import { normalizePdfSettings, type PdfExportSettings } from "./pdfLayout";
import { buildPdfPreview, pdfFontCss } from "./pdfDocument";

// Runs in a separate hidden renderer; never opens a paper or changes the reader's state.
export async function prepareAutomaticPdf(docId: string): Promise<PdfExportRequest> {
  const [rawDoc, rawSettings, state] = await Promise.all([
    window.paperAPI.loadDoc(docId), window.paperAPI.loadSettings(), window.paperAPI.loadState(docId),
  ]);
  const doc = rawDoc as PaperDocument;
  if (!doc.pages?.length) throw new Error("원문 추출이 완료되지 않았습니다.");
  const global = rawSettings as { pdfExport?: PdfExportSettings; typography?: Partial<Typography>; fonts?: UserFont[] } | null;
  const settings = normalizePdfSettings(global?.pdfExport ?? (state as { pdf_export?: PdfExportSettings } | null)?.pdf_export);
  const typography = { ...DEFAULT_TYPOGRAPHY, ...global?.typography };
  registerFonts(global?.fonts ?? []);
  const footnotes = buildFootnotes(doc.blocks);
  const front = buildFrontMatter(doc.blocks);
  const hidden = new Set([...footnotes.pulled, ...front.ids]);
  if (front.startId) hidden.add(front.startId);
  const merge = buildPageMerges(doc.blocks, hidden);
  const blocks = collectTrBlocks(doc, { pulled: footnotes.pulled, frontIds: front.ids, frontStartId: front.startId, merge });
  const cached = await window.paperAPI.cachedTranslations(docId, blocks);
  const entries = new Map(Object.entries(cached));
  const missing = blocks.filter((b) => !b.tableNote && !translatedText(b, entries.get(b.id)));
  if (missing.length) throw new Error(`${missing.length}개 본문·각주 항목의 번역이 남아 있어 PDF를 저장하지 못했습니다.`);
  const token = crypto.randomUUID();
  const html = buildPdfPreview({ doc, blocks, entries, merge, settings,
    fontFamily: typography.trFontLinked ? typography.fontFamily : typography.trFontFamily,
    css: await pdfFontCss(), token, includeSourceImages: false });
  const frame = document.createElement("iframe");
  frame.style.cssText = "width:1600px;height:1200px;border:0";
  document.body.replaceChildren(frame);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("PDF 조판 시간 초과")), 120_000);
    const finish = (error?: Error, pageMap?: number[]) => {
      clearTimeout(timer);
      window.removeEventListener("message", message);
      if (error) return reject(error);
      const clone = frame.contentDocument!.documentElement.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("script, .pdf-source img").forEach((el) => el.remove());
      resolve({ docId, settings, pageMap: pageMap!, html: `<!doctype html>${clone.outerHTML}` });
    };
    const message = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.token !== token) return;
      if (event.data.type === "galpi:pdf-error") finish(new Error(event.data.error));
      else if (event.data.type === "galpi:pdf-ready") finish(undefined, event.data.pageMap);
    };
    window.addEventListener("message", message);
    frame.srcdoc = html;
  });
}
