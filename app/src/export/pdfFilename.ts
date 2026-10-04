import type { PaperDocument } from "../types";

export interface CoverEvidence {
  headerLines?: string[];
  coverLines?: string[];
  pageText?: string;
}
const YEAR = "((?:18|19|20)\\d{2})";
const MONTH = "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan\\.?|Feb\\.?|Mar\\.?|Apr\\.?|Jun\\.?|Jul\\.?|Aug\\.?|Sep\\.?|Sept\\.?|Oct\\.?|Nov\\.?|Dec\\.?)";

// Use publication/header dates and explicit title-page dates. A citation's year
// or the PDF file's creation/modification date is not a document year.
export function documentYear(doc: Pick<PaperDocument, "year">, evidence: CoverEvidence): string | null {
  if (/^(18|19|20)\d{2}$/.test(String(doc.year ?? ""))) return String(doc.year);
  for (const line of evidence.headerLines ?? []) {
    const match = line.match(new RegExp(`\\b${YEAR}\\b`));
    if (match && /\b(?:journal|review|vol\.?|volume|economics|finance)\b/i.test(line)) return match[1];
  }
  for (const line of evidence.coverLines ?? []) {
    const value = line.trim();
    const match = value.match(new RegExp(`^(?:(?:first published|published(?: online)?|publication date|date)\\s*:?\\s*)?${MONTH}\\s+(?:\\d{1,2},?\\s+)?${YEAR}[.,]?$`, "i"))
      ?? value.match(new RegExp(`^(?:(?:발행일|작성일|출판일)\\s*[:：]?\\s*)?${YEAR}\\s*년(?:\\s*\\d{1,2}\\s*월(?:\\s*\\d{1,2}\\s*일)?)?\\s*$`));
    if (match) return match[1];
  }
  const copyright = evidence.pageText?.match(new RegExp(`(?:©|copyright|\\(c\\))\\s*${YEAR}`, "i"));
  return copyright?.[1] ?? null;
}

const cleanAuthor = (s: string) => s.replace(/[∗*†‡§¶]/g, "").replace(/\s+/g, " ").trim();
const norm = (s: string) => cleanAuthor(s).normalize("NFKC").toLowerCase();
function familyName(name: string): string {
  const words = cleanAuthor(name).replace(/(?:,?\s+(?:Jr\.?|Sr\.?|II|III|IV))$/i, "").trim().split(/\s+/);
  let family = words.at(-1) ?? "";
  for (let i = words.length - 2; i >= 0 && /^(?:de|del|la|van|von|da|dos)$/i.test(words[i]); i--) family = words[i] + " " + family;
  if (family === family.toUpperCase() && /[A-Z]/.test(family)) {
    family = family.toLowerCase().replace(/(^|[\s\-’'])[a-z]/g, (c) => c.toUpperCase());
  }
  return family;
}

export function documentAuthors(authors: string | null | undefined, coverLines: string[] = []): string {
  if (!authors?.trim()) return "저자 미상";
  let names = cleanAuthor(authors).split(/\s*(?:,|;|\band\b|&|、)\s*/i).filter(Boolean);
  if (names.length === 1) {
    // Some old documents concatenated separate author lines and a date. Recover
    // only names actually present in both metadata and the original title page.
    const matched = coverLines.map(cleanAuthor).filter((line) => line.split(/\s+/).length >= 2
      && line.length >= 5 && line.length < 80 && norm(authors).includes(norm(line)));
    if (matched.length > 1) names = matched;
  }
  const lastNames = names.map(familyName).filter(Boolean);
  return lastNames.length > 2 ? `${lastNames[0]} et al.` : lastNames.join(" & ") || "저자 미상";
}

function cleanFilename(s: string, stripTrailingDot = true): string {
  return s.normalize("NFKC").replace(/[\\/:]/g, " - ").replace(/[?*"<>|\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ").replace(/(?:\s*-\s*){2,}/g, " - ").trim()
    .replace(stripTrailingDot ? /[.\s-]+$/ : /[\s-]+$/, "");
}
function byteLimit(s: string, max: number): string {
  const encode = new TextEncoder();
  if (encode.encode(s).length <= max) return s;
  const chars = Array.from(s);
  while (chars.length && encode.encode(chars.join("") + "…").length > max) chars.pop();
  return chars.join("").trim() + "…";
}

export function bilingualPdfFilename(doc: Pick<PaperDocument, "authors" | "year" | "title" | "doc_id">,
  evidence: CoverEvidence = {}): string {
  const authors = byteLimit(cleanFilename(documentAuthors(doc.authors, evidence.coverLines), false), 65);
  const year = documentYear(doc, evidence) ?? "연도 미상";
  const prefix = `${authors} (${year}) - `;
  const suffix = " - 원문+번역.pdf";
  const title = cleanFilename(doc.title?.trim() || doc.doc_id) || "논문";
  const budget = 240 - new TextEncoder().encode(prefix + suffix).length;
  return prefix + byteLimit(title, budget) + suffix;
}
