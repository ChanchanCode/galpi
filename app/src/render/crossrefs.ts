// 상호참조 인덱스 (§11-5/§11-7 일반화) — 그림·표·수식·정리/명제(Proposition·Lemma 등)를
// 인덱싱하고, 본문의 언급("Figure 3 / Eq. (6) / Proposition 1 / Lemma 2")을 연결한다.
// 호버 → 프리뷰, 클릭 → 해당 블록으로 이동. 매칭 안 되는 언급은 평범한 텍스트로 둔다.
import { createContext } from "react";
import type { Block } from "../types";

export type RefKind = "figure" | "table" | "eq" | "statement";

export interface RefTarget {
  block: Block;
  kind: RefKind;
  label: string; // 표준 표기 (예: "Proposition 2", "Eq. (3)", "Figure 1")
}

export interface CrossRefData {
  index: Map<string, RefTarget>;
  docId: string;
}
export const CrossRefContext = createContext<CrossRefData>({ index: new Map(), docId: "" });

// 정리/명제류 정의 블록: 블록 선두 "Type N (제목)" (괄호 제목이 정의 신호)
const STMT_DEF = /^\s*(Proposition|Lemma|Theorem|Corollary|Definition|Assumption|Remark|Conjecture)\s+(\d+|[IVX]+)\s*\(/i;
const FIG_LEAD = /^\s*(?:Fig(?:ure)?\.?|그림)\s*\.?\s*(\d+)/i;
const TAB_LEAD = /^\s*(?:Table|표)\s*\.?\s*(\d+)/i;
// 수식 번호 \tag{N} / \tag(N)
const TAG_RE = /\\tag\*?\s*\{?\(?\s*([A-Za-z]?\.?\d+[a-z]?)\s*\)?\}?/;

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function buildCrossRefIndex(blocks: Block[]): Map<string, RefTarget> {
  const index = new Map<string, RefTarget>();
  const put = (key: string, target: RefTarget) => {
    if (!index.has(key)) index.set(key, target);
  };
  for (const b of blocks) {
    const t = b.text ?? "";
    // 정리/명제 (블록 선두 + 괄호 제목)
    const ms = t.match(STMT_DEF);
    if (ms) {
      const type = ms[1].toLowerCase();
      put(`${type}:${ms[2]}`, { block: b, kind: "statement", label: `${cap(ms[1])} ${ms[2]}` });
    }
    // 그림·표 (캡션 선두 번호)
    if (b.type === "figure") {
      const m = t.match(FIG_LEAD);
      if (m) put(`figure:${m[1]}`, { block: b, kind: "figure", label: `Figure ${m[1]}` });
    } else if (b.type === "table") {
      const m = t.match(TAB_LEAD);
      if (m) put(`table:${m[1]}`, { block: b, kind: "table", label: `Table ${m[1]}` });
    } else if (b.type === "caption") {
      const mf = t.match(FIG_LEAD);
      if (mf) put(`figure:${mf[1]}`, { block: b, kind: "figure", label: `Figure ${mf[1]}` });
      const mt = t.match(TAB_LEAD);
      if (mt) put(`table:${mt[1]}`, { block: b, kind: "table", label: `Table ${mt[1]}` });
    }
    // 수식 (\tag 번호)
    if (b.type === "formula") {
      const m = (b.latex ?? "").match(TAG_RE);
      if (m) {
        const num = m[1].trim();
        put(`eq:${num}`, { block: b, kind: "eq", label: `Eq. (${num})` });
      }
    }
  }
  return index;
}

// ── 본문 언급 탐지 ──────────────────────────────────────────────────
export interface Mention {
  start: number;
  end: number;
  key: string;
  label: string;
}

const RE_FIG = /\b(Figure|Fig|Table)\b\.?\s*(\d+)\b/gi;
const RE_EQ = /\b(?:Eqs?\.|Equations?)\s*\(\s*([A-Za-z]?\.?\d+[a-z]?)\s*\)/gi;
const RE_STMT =
  /\b(Proposition|Lemma|Theorem|Corollary|Definition|Assumption|Remark|Conjecture)\s+(\d+|[IVX]+)\b(?!\s*\()/gi;

// text 안에서 인덱스로 해결되는 언급만 위치순으로 반환(겹침 제거).
export function findMentions(text: string, index: Map<string, RefTarget>): Mention[] {
  if (!index.size) return [];
  const out: Mention[] = [];
  let m: RegExpExecArray | null;

  RE_FIG.lastIndex = 0;
  while ((m = RE_FIG.exec(text))) {
    const key = (/^fig/i.test(m[1]) ? "figure:" : "table:") + m[2];
    out.push({ start: m.index, end: m.index + m[0].length, key, label: m[0] });
  }
  RE_EQ.lastIndex = 0;
  while ((m = RE_EQ.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length, key: "eq:" + m[1].trim(), label: m[0] });
  }
  RE_STMT.lastIndex = 0;
  while ((m = RE_STMT.exec(text))) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      key: m[1].toLowerCase() + ":" + m[2],
      label: m[0],
    });
  }

  const resolved = out.filter((x) => index.has(x.key)).sort((a, b) => a.start - b.start);
  // 겹침 제거(앞선 매칭 우선)
  const result: Mention[] = [];
  let lastEnd = -1;
  for (const r of resolved) {
    if (r.start >= lastEnd) {
      result.push(r);
      lastEnd = r.end;
    }
  }
  return result;
}

export function hasResolvableMention(text: string, index: Map<string, RefTarget>): boolean {
  return findMentions(text, index).length > 0;
}
