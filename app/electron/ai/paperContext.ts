// document.json → 채팅/요약 문맥 텍스트. 줄마다 [b0042] 블록 id 를 달아 모델이 근거를 인용하게 한다.
//
// **App 이 그리는 본문과 같은 규칙**을 쓴다(각주 분리·프론트매터·페이지 넘김 병합·장식 라벨 숨김) —
// 어긋나면 모델이 인용한 id 가 화면에 없는 조각(흡수된 블록)을 가리켜 인용 점프가 헛돈다.
// 순수 함수부는 electron 을 import 하지 않는다(node 테스트에서 dist-test 로 번들해 부른다).
import fs from "node:fs/promises";
import path from "node:path";
import type { Block, PaperDocument } from "../../src/types";
import { buildFootnotes } from "../../src/render/footnotes";
import { buildFrontMatter, isSpacedLabel } from "../../src/render/frontmatter";
import { buildPageMerges, type PageMerge } from "../../src/render/pagemerge";
import type { ChatContextMode, PaperSummary } from "./chatTypes";

export const DEFAULT_MAX_CHARS = 160_000;
export const TABLE_CAP = 1500;
export const REFERENCES_CAP = 6000;
export const ABSTRACT_CAP = 3000;
export const TRUNC_MARK = "[…이하 생략]";

export interface PaperContext {
  text: string;
  chars: number;
  blockIds: string[];
}

export interface PaperContextOpts {
  maxChars?: number;
  /** state.json formula_edits — 사용자가 고친 LaTeX 가 화면에 보이는 값이다 */
  formulaEdits?: Record<string, string>;
}

interface Line {
  id: string | null; // null = 머리글·구분 줄(인용 대상 아님)
  text: string;
}

// 한 블록 = 한 줄. 줄바꿈이 섞이면 [bNNNN] 접두가 줄머리에서 떨어져 모델이 id 를 엉뚱한 줄에 붙인다.
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** 표 HTML → 행은 " / ", 칸은 " | " 로 이은 한 줄. 태그는 전부 버린다. */
export function tableHtmlToText(html: string): string {
  return html
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<\/tr>/gi, " / ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/(\s*\|\s*)+\//g, " /")
    .replace(/\s+/g, " ")
    .replace(/^[\s/|]+|[\s/|]+$/g, "");
}

const capText = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** App 의 useMemo(footnotes → frontMatter → pageMerge)와 같은 순서·같은 입력. */
export function hiddenSets(blocks: Block[]) {
  const footnotes = buildFootnotes(blocks);
  const frontMatter = buildFrontMatter(blocks);
  const hidden = new Set<string>(footnotes.pulled);
  frontMatter.ids.forEach((id) => hidden.add(id));
  if (frontMatter.startId) hidden.add(frontMatter.startId);
  const merge: PageMerge = buildPageMerges(blocks, hidden);
  return { footnotes, frontMatter, merge };
}

const REFS_HEADING = /^(\d+\.?\s*|[IVX]+[.)]\s*)?(references|bibliography|literature cited|works cited|참고\s*문헌)\s*:?$/i;
// 표 아래 "Notes:" 같은 제목은 목차에서 잡음이다
const NOISE_HEADING = /^(notes?|sources?)\s*:?$/i;

const SUP_LEAD = /^\s*<sup>(.+?)<\/sup>\s*/i; // footnotes.ts 와 같은 신호 — 각주 캐리어와 footer 잡음을 가른다

function headerLines(doc: PaperDocument, withMeta: boolean): Line[] {
  const out: Line[] = [{ id: null, text: `# ${oneLine(doc.title ?? doc.doc_id)}` }];
  if (withMeta && doc.authors) out.push({ id: null, text: `저자: ${oneLine(doc.authors)}` });
  if (withMeta && doc.journal) out.push({ id: null, text: `저널: ${oneLine(doc.journal)}` });
  return out;
}

function blockLine(b: Block, text: string, formulaEdits?: Record<string, string>): string | null {
  switch (b.type) {
    case "heading":
      return text ? `## [${b.id}] ${text}` : null;
    case "formula": {
      const tex = oneLine(formulaEdits?.[b.id] ?? b.latex ?? "");
      return tex ? `[${b.id}] $$${tex}$$` : null;
    }
    case "table": {
      const body = capText(tableHtmlToText(b.html ?? ""), TABLE_CAP);
      const head = text ? ` ${text}` : "";
      return `[${b.id}] (표)${head}${body ? ` — ${body}` : ""}`;
    }
    case "figure":
      return `[${b.id}] (그림)${text ? ` ${text}` : ""}`;
    default:
      return text ? `[${b.id}] ${text}` : null;
  }
}

const joinLines = (ls: Line[]) => ls.map((l) => l.text).join("\n");
const lenOf = (ls: Line[]) => ls.reduce((n, l) => n + l.text.length + 1, 0);

export function buildPaperContext(
  doc: PaperDocument,
  mode: ChatContextMode,
  summary?: PaperSummary | null,
  opts: PaperContextOpts = {},
): PaperContext {
  const maxChars = Math.max(1000, opts.maxChars ?? DEFAULT_MAX_CHARS);
  if (mode === "none") return finish(headerLines(doc, false), maxChars);
  if (mode === "summary") return finish(summaryLines(doc, summary ?? null), maxChars);

  const blocks = doc.blocks ?? [];
  const { footnotes, frontMatter, merge } = hiddenSets(blocks);
  const body: Line[] = [];
  const notes: Line[] = [];
  const refs: Line[] = [];

  // 참고문헌은 MinerU 가 대개 reference 가 아니라 paragraph 로 준다 → "References" 제목 뒤 문단도 참고문헌으로 본다.
  let inRefs = false;
  for (const b of blocks) {
    if (b.type === "heading") inRefs = REFS_HEADING.test(oneLine(b.text ?? ""));
    // 프론트매터(article info)는 App 에서 접이식으로 그 자리에 보인다 → 내용은 살리고 라벨만 뺀다.
    if (b.id === frontMatter.startId) {
      for (const it of frontMatter.items) {
        const t = oneLine(it.text ?? "");
        if (t && !isSpacedLabel(it.text)) body.push({ id: it.id, text: `[${it.id}] ${t}` });
      }
      continue;
    }
    if (frontMatter.ids.has(b.id)) continue;
    if (merge.absorbed.has(b.id)) continue; // 앞 쪽 문단에 흡수된 조각 — 본문은 기준 블록에 합쳐져 있다
    if (isSpacedLabel(b.text)) continue;
    const text = oneLine(merge.textOverride.get(b.id) ?? b.text ?? "");
    if (footnotes.pulled.has(b.id)) {
      // pulled = 각주 캐리어 + 출판사 footer 잡음. 잡음(doi·ISSN·©)은 문맥 낭비라 버린다.
      if (text && (SUP_LEAD.test(b.text ?? "") || b.type === "footnote")) notes.push({ id: b.id, text: `[${b.id}] ${text}` });
      continue;
    }
    if (b.type === "footnote") {
      if (text) notes.push({ id: b.id, text: `[${b.id}] ${text}` });
      continue;
    }
    if (b.type === "reference" || (inRefs && (b.type === "heading" || b.type === "paragraph" || b.type === "list"))) {
      if (text && b.type !== "heading") refs.push({ id: b.id, text: `[${b.id}] ${text}` });
      continue;
    }
    const line = blockLine(b, text, opts.formulaEdits);
    if (line) body.push({ id: b.id, text: line });
  }

  // 참고문헌은 합계 캡 — 편당 40블록이라 통째로 넣으면 본문보다 비싸다.
  const refsCapped: Line[] = [];
  let refChars = 0;
  for (const r of refs) {
    if (refChars + r.text.length + 1 > REFERENCES_CAP) break;
    refsCapped.push(r);
    refChars += r.text.length + 1;
  }

  const head = headerLines(doc, true);
  const fnHead: Line = { id: null, text: "\n### Footnotes" };
  const refHead: Line = { id: null, text: "\n### References" };
  const total = () =>
    lenOf(head) + 1 + lenOf(body) + (notes.length ? lenOf([fnHead, ...notes]) : 0) + (refsCapped.length ? lenOf([refHead, ...refsCapped]) : 0);

  // 넘치면 references → footnotes → 본문 뒤쪽 순서로 줄인다(본문 앞부분이 질문과 가장 자주 닿는다).
  while (total() > maxChars && refsCapped.length) refsCapped.pop();
  while (total() > maxChars && notes.length) notes.pop();
  let truncated = false;
  if (total() > maxChars) {
    truncated = true;
    while (total() + TRUNC_MARK.length + 1 > maxChars && body.length) body.pop();
  }

  const lines: Line[] = [...head, { id: null, text: "" }, ...body];
  if (truncated) lines.push({ id: null, text: TRUNC_MARK });
  if (notes.length) lines.push(fnHead, ...notes);
  if (refsCapped.length) lines.push(refHead, ...refsCapped);
  return finish(lines, maxChars);
}

function finish(lines: Line[], maxChars: number): PaperContext {
  let text = joinLines(lines);
  const blockIds = lines.filter((l) => l.id).map((l) => l.id!) as string[];
  if (text.length > maxChars) text = text.slice(0, maxChars - TRUNC_MARK.length - 1) + "\n" + TRUNC_MARK; // 요약 모드 안전망
  return { text, chars: text.length, blockIds };
}

const normLabel = (s: string) => s.replace(/\s+/g, "").replace(/[:.]+$/, "").toLowerCase();

/** 초록 블록 찾기 — "Abstract" 라벨(제목·문단·장식 라벨) 뒤 문단, 없으면 첫 절 제목 전의 긴 문단. */
export function findAbstract(doc: PaperDocument, sets = hiddenSets(doc.blocks ?? [])): Block[] {
  const blocks = doc.blocks ?? [];
  const { footnotes, frontMatter, merge } = sets;
  const visible = blocks.filter((b) => !footnotes.pulled.has(b.id) && !merge.absorbed.has(b.id));
  const take = (from: number): Block[] => {
    const out: Block[] = [];
    let chars = 0;
    for (let i = from; i < visible.length && out.length < 2; i++) {
      const b = visible[i];
      if (b.type === "heading") break;
      if (b.type !== "paragraph") continue;
      out.push(b);
      chars += (merge.textOverride.get(b.id) ?? b.text ?? "").length;
      if (chars > 600) break; // 초록은 대개 한 문단 — 긴 첫 문단 뒤는 서론일 가능성이 크다
    }
    return out;
  };
  for (let i = 0; i < visible.length; i++) {
    const b = visible[i];
    const t = b.text ?? "";
    if (normLabel(t) === "abstract") return take(i + 1);
    if (b.type === "paragraph" && /^\s*abstract\s*[:.—–-]\s*\S/i.test(t)) return [b, ...take(i + 1)].slice(0, 2);
  }
  const title = normLabel(doc.title ?? "");
  const out: Block[] = [];
  for (const b of visible) {
    if (frontMatter.ids.has(b.id)) continue;
    if (b.type === "heading") {
      if (normLabel(b.text ?? "") === title || (out.length === 0 && b === visible[0])) continue; // 제목 heading 은 넘긴다
      break;
    }
    if (b.type === "paragraph" && (b.text ?? "").length >= 200) out.push(b);
    if (out.length >= 2) break;
  }
  return out;
}

function summaryLines(doc: PaperDocument, summary: PaperSummary | null): Line[] {
  const lines: Line[] = headerLines(doc, true);
  const sets = hiddenSets(doc.blocks ?? []);
  const { footnotes, frontMatter, merge } = sets;
  const abs = findAbstract(doc, sets);
  if (abs.length) {
    lines.push({ id: null, text: "\n### Abstract" });
    let chars = 0;
    for (const b of abs) {
      const t = capText(oneLine(merge.textOverride.get(b.id) ?? b.text ?? "").replace(/^abstract\s*[:.—–-]\s*/i, ""), ABSTRACT_CAP - chars);
      if (!t) continue;
      lines.push({ id: b.id, text: `[${b.id}] ${t}` });
      chars += t.length;
      if (chars >= ABSTRACT_CAP) break;
    }
  }
  const heads = (doc.blocks ?? []).filter(
    (b) => b.type === "heading" && !footnotes.pulled.has(b.id) && !frontMatter.ids.has(b.id) && !isSpacedLabel(b.text) && (b.text ?? "").trim() && !NOISE_HEADING.test(oneLine(b.text ?? "")),
  );
  if (heads.length) {
    lines.push({ id: null, text: "\n### Sections" });
    for (const h of heads.slice(0, 150)) lines.push({ id: h.id, text: `- [${h.id}] ${oneLine(h.text ?? "")}` });
  }
  if (summary) {
    const sec = (label: string, v: string | string[] | undefined) => {
      if (!v || (Array.isArray(v) && !v.length)) return;
      lines.push({ id: null, text: `\n### ${label}` });
      if (Array.isArray(v)) for (const x of v) lines.push({ id: null, text: `- ${x}` });
      else lines.push({ id: null, text: v });
    };
    sec("요약 TL;DR", summary.tldr);
    sec("연구 질문", summary.question);
    sec("방법", summary.method);
    sec("데이터", summary.data);
    sec("핵심 결과", summary.findings);
    sec("기여", summary.contributions);
    sec("한계", summary.limitations);
    sec("키워드", summary.keywords?.length ? summary.keywords.join(", ") : undefined);
    if (!summary.tldr && summary.raw) sec("요약", summary.raw);
  }
  return lines;
}

// ── 얇은 fs 로더 (electron 무관 — 경로는 호출자가 준다) ─────────────────
const docCache = new Map<string, { mtimeMs: number; doc: PaperDocument }>();

/** document.json 을 mtime 키로 메모리 캐시. 추출 중 점진 기록되면 mtime 이 바뀌어 다시 읽는다. */
export async function loadDocumentCached(docDir: string): Promise<{ doc: PaperDocument; mtimeMs: number } | null> {
  const file = path.join(docDir, "document.json");
  try {
    const st = await fs.stat(file);
    const hit = docCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit;
    const doc = JSON.parse(await fs.readFile(file, "utf8")) as PaperDocument;
    if (!doc || !Array.isArray(doc.blocks)) return null;
    const entry = { mtimeMs: st.mtimeMs, doc };
    docCache.set(file, entry);
    if (docCache.size > 6) docCache.delete(docCache.keys().next().value!); // 가장 먼저 들어온 것부터 버림
    return entry;
  } catch {
    return null;
  }
}

/** state.json 의 수식 수동 편집(App 이 화면에 적용하는 값). 없으면 {}. */
export async function loadFormulaEdits(docDir: string): Promise<{ edits: Record<string, string>; mtimeMs: number }> {
  const file = path.join(docDir, "state.json");
  try {
    const st = await fs.stat(file);
    const j = JSON.parse(await fs.readFile(file, "utf8")) as { formula_edits?: unknown };
    const fe = j?.formula_edits;
    const edits: Record<string, string> = {};
    if (fe && typeof fe === "object") for (const [k, v] of Object.entries(fe)) if (typeof v === "string") edits[k] = v;
    return { edits, mtimeMs: st.mtimeMs };
  } catch {
    return { edits: {}, mtimeMs: 0 };
  }
}
