// 번역 대상 블록 고르기 — **화면에 실제로 렌더된 블록과 1:1 로 맞춰야 한다.**
// 카드는 블록 위치를 재서 붙이므로(D20), 여기서 고른 것과 App 이 그린 것이 어긋나면 카드가 뜬다.
import type { Block, PaperDocument } from "../types";
import { isSpacedLabel } from "../render/frontmatter";
import type { PageMerge } from "../render/pagemerge";
import { isBrokenTableText } from "./translationContent";

export type TrKind = "para" | "title" | "footnote" | "list" | "formula" | "table" | "other";

export interface TrSource {
  id: string;
  text: string;
  kind: TrKind;
  page: number;
  type: Block["type"];
  level?: number; // heading 전용 — 번역 카드도 원문과 같은 위계로 그린다
  tableNote?: boolean; // Damaged rotated table description; show only a usable translation.
}

// 번역하는 타입. 빠진 것들의 이유:
//  · formula/table/figure — 글이 아니다(LaTeX·HTML·이미지).
//  · reference — 참고문헌. 번역해도 값이 없고 편당 40블록이라 비용만 먹는다.
//  · footnote — 각주는 접힌 <details> 로 끌려 나가 있어 카드를 붙일 자리가 없다.
const TRANSLATE_TYPES = new Set<Block["type"]>(["paragraph", "heading", "list", "caption"]);

const KIND: Partial<Record<Block["type"], TrKind>> = {
  paragraph: "para",
  heading: "title",
  list: "list",
  caption: "para",
};

export interface HiddenSets {
  pulled: Set<string>;
  frontIds: Set<string>;
  frontStartId: string | null;
  merge: PageMerge;
}

const MIN_CHARS = 2;

export function collectTrBlocks(doc: PaperDocument, h: HiddenSets): TrSource[] {
  const out: TrSource[] = [];
  for (const b of doc.blocks) {
    if (h.pulled.has(b.id) || h.frontIds.has(b.id) || b.id === h.frontStartId) continue;
    if (h.merge.absorbed.has(b.id)) continue;
    if (isSpacedLabel(b.text)) continue;
    if (!TRANSLATE_TYPES.has(b.type)) continue;
    // **페이지를 넘어 합쳐진 본문**을 넘긴다(§5.1). 조각째 주면 모델이 뒷부분을 지어낸다.
    const text = (h.merge.textOverride.get(b.id) ?? b.text ?? "").trim();
    if (text.length < MIN_CHARS) continue;
    const tableNote = isBrokenTableText(b, doc);
    if (tableNote && text.replace(/<[^>]*>/g, "").replace(/\s+/g, "").length < 40) continue;
    out.push({ id: b.id, text, kind: KIND[b.type] ?? "other", page: b.page, type: b.type, level: b.level, tableNote });
  }
  return out;
}

/** 뷰포트에 가까운 것부터 — 위에서부터 채우면 읽던 화면이 마지막에 칠해진다. */
export function viewportFirst(blocks: TrSource[], container: HTMLElement | null): TrSource[] {
  if (!container) return blocks;
  const mid = window.innerHeight / 2;
  const rank = new Map<string, number>();
  for (const el of container.querySelectorAll<HTMLElement>("[data-block-id]")) {
    const r = el.getBoundingClientRect();
    rank.set(el.dataset.blockId!, Math.abs(r.top + r.height / 2 - mid));
  }
  const far = Number.MAX_SAFE_INTEGER;
  return [...blocks].sort((a, b) => (rank.get(a.id) ?? far) - (rank.get(b.id) ?? far));
}
