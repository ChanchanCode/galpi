// Shared safe inline formatting for translation cards and printed PDF.
// Parse a small allowlist; never execute or interpolate arbitrary model HTML.
import katex from "katex";

export type TranslationToken =
  | { kind: "text"; text: string }
  | { kind: "math"; tex: string; raw: string; display: boolean }
  | { kind: "element"; tag: "sup" | "sub" | "i" | "b" | "em" | "strong"; children: TranslationToken[] }
  | { kind: "br" };

const TOKEN = /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$(?!\$)(.+?)(?<!\\)\$(?!\$)|<(sup|sub|i|b|em|strong)\b[^>]*>([\s\S]*?)<\/\5\s*>|<br\s*\/?>/gi;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", minus: "−", times: "×", le: "≤", ge: "≥" };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash|minus|times|le|ge);/gi, (raw, name: string) => {
    if (!name.startsWith("#")) return ENTITIES[name.toLowerCase()] ?? raw;
    const number = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : raw;
  });
}
export function translationTokens(input: string, depth = 0): TranslationToken[] {
  const text = depth ? input : decodeEntities(input);
  const tokens: TranslationToken[] = [];
  const plain = (value: string) => {
    if (value) tokens.push({ kind: "text", text: value.replace(/\\\$/g, "$").replace(/<\/?(?:sup|sub|i|b|em|strong|br)\b[^>]*>/gi, "") });
  };
  if (depth > 8) { plain(text); return tokens; }
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    plain(text.slice(last, match.index));
    const tex = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (tex !== undefined) tokens.push({ kind: "math", tex, raw: match[0], display: match[1] !== undefined || match[2] !== undefined });
    else if (match[5]) tokens.push({ kind: "element", tag: match[5].toLowerCase() as Extract<TranslationToken, {kind:"element"}>["tag"], children: translationTokens(match[6], depth + 1) });
    else tokens.push({ kind: "br" });
    last = match.index! + match[0].length;
  }
  plain(text.slice(last));
  return tokens;
}

export function tokenText(tokens: TranslationToken[]): string {
  return tokens.map((token) => token.kind === "text" ? token.text : token.kind === "element" ? tokenText(token.children) : token.kind === "br" ? "\n" : token.raw).join("");
}
export function footnoteLabel(token: TranslationToken): string | null {
  if (token.kind !== "element" || token.tag !== "sup" || !token.children.every((t) => t.kind === "text")) return null;
  const label = tokenText(token.children).trim();
  return /^(?:\d{1,3}|[*∗†‡])$/.test(label) ? label : null;
}
export function referencedFootnotes(text: string): string[] {
  const labels = new Set<string>();
  const visit = (tokens: TranslationToken[]) => {
    for (const token of tokens) {
      const label = footnoteLabel(token);
      if (label) labels.add(label);
      if (token.kind === "element") visit(token.children);
    }
  };
  visit(translationTokens(text));
  return [...labels];
}
const mathCache = new Map<string, string | null>();
export function translationMathHtml(token: Extract<TranslationToken, { kind: "math" }>): string | null {
  const key = `${token.display}:${token.tex}`;
  if (mathCache.has(key)) return mathCache.get(key)!;
  let html: string | null;
  try { html = katex.renderToString(token.tex, { displayMode: token.display, throwOnError: true, strict: false, trust: false }); }
  catch { html = null; }
  if (mathCache.size > 4000) mathCache.clear();
  mathCache.set(key, html);
  return html;
}
export const escapeTranslationHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// Separate word-sized nodes keep PDF pagination possible, even in formatted text.
export function translationHtml(text: string, noteHref?: (label: string) => string | undefined): string {
  const render = (tokens: TranslationToken[]): string[] => tokens.flatMap((token): string[] => {
    if (token.kind === "text") return (token.text.match(/\s+|\S+/gu) ?? []).flatMap((word) =>
      (word.length > 60 ? Array.from(word) : [word]).map((part) => `<span>${escapeTranslationHtml(part)}</span>`));
    if (token.kind === "br") return ["<br>"];
    if (token.kind === "math") {
      const html = translationMathHtml(token);
      return [html ? `<span class="pdf-math${token.display ? " pdf-math-display" : ""}">${html}</span>`
        : `<span class="pdf-math-raw">${escapeTranslationHtml(token.raw)}</span>`];
    }
    const label = footnoteLabel(token);
    const href = label ? noteHref?.(label) : undefined;
    if (href?.startsWith("#")) return [`<sup class="pdf-fn-ref"><a data-pdf-note="true" href="${escapeTranslationHtml(href)}">${escapeTranslationHtml(label!)}</a></sup>`];
    return render(token.children).map((child) => `<${token.tag}>${child}</${token.tag}>`);
  });
  return render(translationTokens(text)).join("");
}
