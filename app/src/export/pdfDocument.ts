import type { PaperDocument } from "../types";
import type { PageMerge } from "../render/pagemerge";
import type { TrSource } from "../translate/trBlocks";
import type { TrEntry } from "../translate/useTranslation";
import { fitSourcePage, pdfGeometry, type PdfExportSettings } from "./pdfLayout";
import RUNTIME from "./pdfRuntime.js?raw";
import FIT_RUNTIME from "./pdfFit.js?raw";
import { translatedText } from "../translate/translationContent";
import { referencedFootnotes, translationHtml } from "../translate/translationMarkup";
import { buildFootnotes } from "../render/footnotes";
export { translationHtml } from "../translate/translationMarkup";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function buildPdfPreview({ doc, blocks, entries, merge, settings, fontFamily, css, token } : {
  doc: PaperDocument; blocks: TrSource[]; entries: Map<string, TrEntry>; merge: PageMerge;
  settings: PdfExportSettings; fontFamily: string; css: string; token: string;
}): string {
  const g = pdfGeometry(settings);
  const pageOf = new Map(doc.blocks.map((b) => [b.id, b.page]));
  const continued = new Map<number, number>();
  for (const [absorbed, base] of merge.baseOf) {
    const p = pageOf.get(absorbed);
    const from = pageOf.get(base);
    if (p != null && from != null && from < p && !continued.has(p)) continued.set(p, from);
  }
  const byPage = new Map<number, { html: string }[]>();
  const notes = buildFootnotes(doc.blocks).byLabel;
  const references = new Map<number, Set<string>>();
  for (const b of blocks) {
    const entry = entries.get(b.id);
    const text = translatedText(b, entry);
    if (b.tableNote && !text) continue;
    const labels = references.get(b.page) ?? new Set<string>();
    for (const label of referencedFootnotes(text)) if (notes.has(label)) labels.add(label);
    references.set(b.page, labels);
    const level = Math.min(6, Math.max(1, b.level ?? 2));
    const content = text ? translationHtml(text, (label) => notes.has(label) ? `#pdf-note-${b.page}-${label}` : undefined) : '<span class="pdf-missing">[아직 번역되지 않은 문단]</span>';
    const list = byPage.get(b.page) ?? [];
    list.push({ html: `<p class="pdf-block ${b.type === "heading" ? `pdf-heading pdf-level-${level}` : b.tableNote ? "pdf-table-note" : ""}">${b.tableNote ? '<span class="pdf-note-label">표 설명</span>' : ""}${content}</p>` });
    byPage.set(b.page, list);
  }
  for (const [page, labels] of references) {
    const list = byPage.get(page)!;
    for (const label of labels) {
      const note = notes.get(label)!;
      list.push({ html: `<p class="pdf-block pdf-footnote" id="pdf-note-${page}-${escapeHtml(label)}"><span class="pdf-note-label">원문 각주 ${escapeHtml(label)}</span>${translationHtml(note.html)}</p>` });
    }
  }
  const data = { token, title: doc.title ?? doc.doc_id, bodyHeight: g.bodyHeight,
    translationWidth: g.translationWidth, settings,
    pages: doc.pages.map((p) => ({ index: p.index, continuedFrom: continued.get(p.index),
      sourceFit: fitSourcePage(settings, p.width_pt, p.height_pt),
      url: window.paperAPI.assetUrl(doc.doc_id, p.is_vector && p.svg ? p.svg : p.image),
      blocks: byPage.get(p.index) ?? [] })) };
  return `<!doctype html><html data-token="${escapeHtml(token)}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src paper: data:; font-src data: file: http://localhost:5123; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(doc.title ?? doc.doc_id)}</title><style>${css.replace(/<\/style/gi, "<\\/style")}</style><style>
@page { size: ${g.width}pt ${g.height}pt; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #e8e8e6; color: #202422; }
.pdf-sheet { position: relative; width: ${g.width}pt; height: ${g.height}pt; margin: 0 auto 16px;
  background: white; overflow: hidden; break-after: page; box-shadow: 0 2px 12px #0002; }
.pdf-sheet:last-child { break-after: auto; }
.pdf-sheet header, .pdf-sheet footer { position: absolute; left: ${g.margin}pt; right: ${g.margin}pt;
  font: 8pt -apple-system, 'Malgun Gothic', sans-serif; color: #747c76; }
.pdf-sheet header { top: ${g.margin}pt; display: flex; justify-content: space-between; gap: 16pt; }
.pdf-sheet header span:first-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pdf-sheet header span:last-child { white-space: nowrap; }
.pdf-sheet footer { bottom: ${g.margin}pt; text-align: right; }
.pdf-source { position: absolute; left: ${g.margin}pt; top: ${g.top}pt;
  width: ${g.sourceWidth}pt; height: ${g.bodyHeight}pt; }
.pdf-source img { display: block; width: 100%; height: 100%; }
.pdf-divider { position: absolute; left: ${g.margin + g.sourceWidth + g.gap / 2}pt; top: ${g.top}pt;
  height: ${g.bodyHeight}pt; border-left: 0.5pt solid #e2e5e2; }
.pdf-translation { position: absolute; left: ${g.margin + g.sourceWidth + g.gap}pt; top: ${g.top}pt;
  width: ${g.translationWidth}pt; height: ${g.bodyHeight}pt;
  padding: ${settings.paddingTop}mm ${settings.paddingHorizontal}mm ${settings.paddingBottom}mm; }
.pdf-flow, #pdf-measure { font-family: ${(settings.fontFamily || fontFamily).replace(/[;{}<>]/g, "")}; font-size: ${settings.fontSize}pt;
  line-height: ${settings.lineHeight}; overflow-wrap: anywhere; color: #202422; }
.pdf-block { margin: 0; padding: 0 0 ${settings.paragraphSpacing}em; white-space: pre-wrap; }
.pdf-heading { font-weight: 650; }
.pdf-level-1 { font-size: 1.4em; } .pdf-level-2 { font-size: 1.18em; }
.pdf-paragraph-continued { padding-top: 0; }
.pdf-note { margin: 0; padding-bottom: ${settings.paragraphSpacing}em; color: #8a8276; }
.pdf-missing { color: #8a8276; }
.pdf-math { display: inline-block; max-width: 100%; }
.pdf-math-display { display: block; }
.pdf-math-display .katex-display { margin: .6em 0; }
.pdf-table-note, .pdf-footnote { font-size: .85em; padding-left: 8pt; border-left: 1pt solid #d5dad5; }
.pdf-footnote { margin-top: .5em; }
.pdf-note-label { display: block; font-size: .85em; color: #747c76; padding-bottom: .3em; }
.pdf-fn-ref a { color: #3e6650; text-decoration: none; }
.pdf-footnote.flash { background: #edf5ef; }
.pdf-math-raw { color: #8a8276; }
.katex { color: inherit; } .katex .katex-mathml { display: none; }
#pdf-measure { position: absolute; visibility: hidden; width: ${g.translationWidth}pt; }
@media screen { html { overflow: hidden; } }
@media print { html, body { background: white; } .pdf-sheet { margin: 0; box-shadow: none; }
  .pdf-source img { display: none; } }
</style></head><body><div id="pdf-pages"></div><div id="pdf-measure"></div>
<script id="pdf-data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script type="module">${FIT_RUNTIME}\n${RUNTIME}</script></body></html>`;
}

// Only font faces and KaTeX layout rules belong in the isolated print document.
export async function pdfFontCss(): Promise<string> {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let cssRules: CSSRuleList;
    try { cssRules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(cssRules)) {
      if (rule instanceof CSSFontFaceRule) {
        let value = rule.cssText;
        const urls = Array.from(value.matchAll(/url\(["']?([^"')]+)["']?\)/g));
        for (const url of urls) {
          if (url[1].startsWith("data:")) continue;
          const res = await fetch(new URL(url[1], sheet.href ?? location.href));
          if (!res.ok) throw new Error("수식 글꼴을 불러오지 못했습니다.");
          const blob = await res.blob();
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          value = value.replace(url[0], `url("${data}")`);
        }
        rules.push(value);
      } else if (rule.cssText.startsWith(".katex")) rules.push(rule.cssText);
    }
  }
  return rules.join("\n");
}
