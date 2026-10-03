import katex from "katex";
import type { PaperDocument } from "../types";
import type { PageMerge } from "../render/pagemerge";
import type { TrSource } from "../translate/trBlocks";
import type { TrEntry } from "../translate/useTranslation";
import { pdfGeometry, type PdfExportSettings } from "./pdfLayout";
import RUNTIME from "./pdfRuntime.js?raw";
import FIT_RUNTIME from "./pdfFit.js?raw";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// Plain text remains plain text, with the same escaped-dollar convention as TrText.
export function translationHtml(text: string): string {
  const tokens: string[] = [];
  let last = 0;
  const plain = (value: string) => {
    // Long unspaced paragraphs also need boundaries at which pagination can split.
    for (const word of value.match(/\s+|\S+/gu) ?? []) {
      if (word.length > 60) {
        for (const char of Array.from(word)) tokens.push(`<span>${escapeHtml(char)}</span>`);
      } else tokens.push(`<span>${escapeHtml(word)}</span>`);
    }
  };
  for (const match of text.matchAll(/(?<!\\)\$(.+?)(?<!\\)\$/g)) {
    plain(text.slice(last, match.index));
    try {
      tokens.push(`<span class="pdf-math">${katex.renderToString(match[1], { throwOnError: true, strict: false, trust: false })}</span>`);
    } catch { tokens.push(`<span>${escapeHtml(match[0])}</span>`); }
    last = match.index! + match[0].length;
  }
  plain(text.slice(last));
  return tokens.join("");
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
  for (const b of blocks) {
    const entry = entries.get(b.id);
    const text = entry?.ko.trim() || entry?.spans?.map((s) => s.ko).join(" ").trim();
    const level = Math.min(6, Math.max(1, b.level ?? 2));
    const content = text ? translationHtml(text) : '<span class="pdf-missing">[아직 번역되지 않은 문단]</span>';
    const list = byPage.get(b.page) ?? [];
    list.push({ html: `<p class="pdf-block ${b.type === "heading" ? `pdf-heading pdf-level-${level}` : ""}">${content}</p>` });
    byPage.set(b.page, list);
  }
  const data = { token, title: doc.title ?? doc.doc_id, bodyHeight: g.bodyHeight,
    translationWidth: g.translationWidth, settings,
    pages: doc.pages.map((p) => ({ index: p.index, continuedFrom: continued.get(p.index),
      url: window.paperAPI.assetUrl(doc.doc_id, p.is_vector && p.svg ? p.svg : p.image),
      blocks: byPage.get(p.index) ?? [] })) };
  return `<!doctype html><html data-token="${escapeHtml(token)}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src paper: data:; font-src data: file: http://localhost:5123; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(doc.title ?? doc.doc_id)}</title><style>${css.replace(/<\/style/gi, "<\\/style")}</style><style>
@page { size: ${g.width}pt ${g.height}pt; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #e8e8e6; color: #202422; }
.pdf-sheet { position: relative; width: ${g.width}pt; height: ${g.height}pt; margin: 16px auto;
  background: white; overflow: hidden; break-after: page; box-shadow: 0 2px 12px #0002; }
.pdf-sheet:last-child { break-after: auto; }
.pdf-sheet header, .pdf-sheet footer { position: absolute; left: ${g.margin}pt; right: ${g.margin}pt;
  font: 8pt -apple-system, 'Malgun Gothic', sans-serif; color: #747c76; }
.pdf-sheet header { top: 20pt; display: flex; justify-content: space-between; gap: 16pt; }
.pdf-sheet header span:first-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pdf-sheet header span:last-child { white-space: nowrap; }
.pdf-sheet footer { bottom: 14pt; text-align: right; }
.pdf-source { position: absolute; left: ${g.margin}pt; top: ${g.top}pt;
  width: ${g.sourceWidth}pt; height: ${g.bodyHeight}pt; }
.pdf-source img { display: block; width: 100%; height: 100%; object-fit: contain; }
.pdf-translation { position: absolute; left: ${g.margin + g.sourceWidth + g.gap}pt; top: ${g.top}pt;
  width: ${g.translationWidth}pt; height: ${g.bodyHeight}pt;
  padding: ${settings.paddingTop}mm ${settings.paddingHorizontal}mm ${settings.paddingBottom}mm; }
.pdf-flow, #pdf-measure { font-family: ${fontFamily.replace(/[;{}<>]/g, "")}; font-size: ${settings.fontSize}pt;
  line-height: ${settings.lineHeight}; overflow-wrap: anywhere; color: #202422; }
.pdf-block { margin: 0; padding: 0 0 0.85em; white-space: pre-wrap; }
.pdf-heading { font-weight: 650; line-height: 1.4; }
.pdf-level-1 { font-size: 1.4em; } .pdf-level-2 { font-size: 1.18em; }
.pdf-paragraph-continued { padding-top: 0; }
.pdf-note, .pdf-missing { font: 9pt/1.6 -apple-system, 'Malgun Gothic', sans-serif; color: #8a8276; }
.pdf-math { display: inline-block; max-width: 100%; }
.katex { color: inherit; } .katex .katex-mathml { display: none; }
#pdf-measure { position: absolute; visibility: hidden; width: ${g.translationWidth}pt; }
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
