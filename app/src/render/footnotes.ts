// 각주 분리·매칭 (명세 §6.1 보강).
// '<sup>라벨</sup> …' 로 시작하는 각주 정의를 본문 흐름에서 빼내고,
// 본문의 같은 <sup>라벨</sup> 참조를 클릭형 팝오버로 연결한다.
// ※ MinerU 가 각주를 footnote 가 아니라 list/paragraph 로 오분류하는 경우가 많고(특히 긴 각주),
//   한 블록에 여러 각주(<sup>1</sup>… <sup>2</sup>…)가 붙어 있기도 하다 → 블록 타입과 무관하게
//   '선두 <sup>라벨</sup>' 신호로 잡고, 한 블록 안 여러 마커를 각각의 각주로 쪼갠다.
import { createContext } from "react";
import type { Block } from "../types";

export interface Footnote {
  label: string; // "1", "∗" 등
  html: string; // 각주 본문(인라인 HTML/수식 포함 가능)
}

export interface FootnoteData {
  byLabel: Map<string, Footnote>;
  pulled: Set<string>; // 본문 흐름에서 제거할 블록 id (각주 + 출판사 footer 잡음)
  ordered: Footnote[]; // 표시 순서(숫자 우선, 그다음 기호)
}

const SUP_LEAD = /^\s*<sup>(.+?)<\/sup>\s*/i;
// 명백한 출판사 footer 잡음(단독 문단) — 본문에서 숨김
const JUNK = [
  /^https?:\/\/doi\.org\//i,
  /^\d{4}-\d{3}[\dxX]\b/, // ISSN (예: 0304-405X/© ...)
  /©.{0,40}all rights reserved/i,
];

// 각주 연속분 이어붙이기: 앞이 단어로 끝나고 뒤가 소문자로 시작하면 공백 없이(컬럼 경계 절단).
function joinCont(prev: string, next: string): string {
  const a = prev.replace(/\s+$/, "");
  const b = next.replace(/^\s+/, "");
  const glue = /\w$/.test(a) && /^[a-z]/.test(b) ? "" : " ";
  return a + glue + b;
}

// 한 블록 안의 각주 정의 마커들을 찾아 각각의 각주로 분할.
// 정의 마커 = 문자열 시작 또는 공백 뒤의 <sup>라벨</sup> + 뒤따르는 공백
// (본문 참조 마커는 'topic.<sup>2</sup>' 처럼 단어/문장부호에 '붙어' 있어 제외된다).
function splitFootnoteDefs(text: string): Footnote[] {
  const re = /(^|\s)<sup>([^<>\s]{1,6})<\/sup>\s+/g;
  const marks: { label: string; markStart: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    marks.push({ label: m[2].trim(), markStart: m.index + m[1].length, bodyStart: re.lastIndex });
  }
  // 공백 없는 변형('<sup>1</sup>본문')도 최소 1개는 잡도록 폴백
  if (!marks.length) {
    const mm = text.match(SUP_LEAD);
    return mm ? [{ label: mm[1].trim(), html: text.slice(mm[0].length).trim() }] : [];
  }
  return marks.map((mk, i) => ({
    label: mk.label,
    html: text.slice(mk.bodyStart, i + 1 < marks.length ? marks[i + 1].markStart : text.length).trim(),
  }));
}

export function buildFootnotes(blocks: Block[]): FootnoteData {
  const byLabel = new Map<string, Footnote>();
  const pulled = new Set<string>();
  let current: Footnote | null = null; // 직전 마커 각주(연속분 병합 대상)
  for (const b of blocks) {
    const text = b.text ?? "";
    if (b.type === "heading") {
      current = null; // 섹션이 바뀌면 연속 병합 끊기
      continue;
    }
    // 1) '선두 <sup>라벨</sup>' 로 시작하면 각주 정의 캐리어 — 타입(footnote/list/paragraph) 무관.
    //    한 블록에 여러 각주가 붙어 있으면 마커 단위로 쪼개 모두 등록.
    if (text && SUP_LEAD.test(text)) {
      const defs = splitFootnoteDefs(text);
      if (defs.length) {
        for (const d of defs) if (!byLabel.has(d.label)) byLabel.set(d.label, d);
        current = byLabel.get(defs[defs.length - 1].label) ?? null;
        pulled.add(b.id);
        continue;
      }
    }
    // 2) 마커 없는 각주 연속분(컬럼 절단으로 다음 블록에 이어진 경우) → 직전 각주에 병합.
    //    오인 위험을 줄이려 footnote 타입에만 적용.
    if (b.type === "footnote" && text && current) {
      current.html = joinCont(current.html, text);
      pulled.add(b.id);
      continue;
    }
    // 3) 출판사 footer 잡음은 숨기되, 연속 병합은 끊지 않음(각주 절반 사이에 끼어듦)
    if (b.type === "paragraph" && JUNK.some((re) => re.test(text.trim()))) {
      pulled.add(b.id);
    }
  }
  const ordered = [...byLabel.values()].sort((a, b) => {
    const na = parseInt(a.label, 10);
    const nb = parseInt(b.label, 10);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    if (!isNaN(na)) return -1;
    if (!isNaN(nb)) return 1;
    return a.label.localeCompare(b.label);
  });
  return { byLabel, pulled, ordered };
}

// 본문 RichText 가 참조 마커를 클릭형으로 바꿀 수 있도록 맵을 컨텍스트로 제공.
export const FootnoteContext = createContext<Map<string, Footnote>>(new Map());
