import type { Block, PaperDocument } from "../types";
import type { TrSource } from "./trBlocks";
import type { TrEntry } from "./useTranslation";

// Rotated table-side text often arrives as upright paragraphs with letters wrongly
// marked as superscripts and every word glued together. Keep this decision tied to
// table geometry and explicit extraction defects, never to English/Korean alone.
export function isBrokenTableText(block: Block, doc: PaperDocument): boolean {
  if (!block.bbox || !block.text || !["paragraph", "heading", "caption"].includes(block.type)) return false;
  const [left, top, right, bottom] = block.bbox;
  const height = bottom - top, width = right - left;
  if (width <= 0 || height < 20 || height / width < 2.5) return false;
  const corrupted = (block.text.match(/<(?:sup|sub)>/gi)?.length ?? 0) >= 2 || /[A-Za-z]{35,}/.test(block.text);
  if (!corrupted) return false;
  const pageWidth = doc.pages.find((page) => page.index === block.page)?.width_pt ?? 0;
  return doc.blocks.some((table) => {
    if (table.page !== block.page || table.type !== "table" || !table.bbox) return false;
    const [x0, y0, x1, y1] = table.bbox;
    const overlap = Math.min(bottom, y1) - Math.max(top, y0);
    const gap = Math.max(0, x0 - right, left - x1);
    return overlap >= Math.min(height, y1 - y0) * .7 && gap < pageWidth * .3;
  });
}

export function translatedText(block: TrSource, entry: TrEntry | undefined): string {
  let text = entry?.ko.trim() || entry?.spans?.map((span) => span.ko).join(" ").trim() || "";
  if (!block.tableNote) return text;
  // The cached model result may have echoed the damaged input before a valid Korean
  // translation. Remove only an exact source prefix; preserve the actual translation.
  if (text.startsWith(block.text)) text = text.slice(block.text.length).trim();
  else if (text.replace(/\s+/g, "") === block.text.replace(/\s+/g, "")) text = "";
  // An unchanged/partial rotated English extraction is not a Korean translation.
  return /[가-힣]{2}/.test(text) ? text : "";
}
export function translationFragments(block: TrSource, entry: TrEntry): { text: string; index: number | null }[] {
  if (block.tableNote) {
    const text = translatedText(block, entry);
    return text ? [{ text, index: null }] : [];
  }
  return entry.spans?.length ? entry.spans.map((span, index) => ({ text: span.ko, index })) : [{ text: entry.ko, index: null }];
}
