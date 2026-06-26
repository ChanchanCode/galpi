// 각주 분리·매칭 (명세 §6.1 보강).
// MinerU 가 footnote 로 잡은 블록 중 '<sup>라벨</sup> …' 로 시작하는 정의를
// 본문 흐름에서 빼내고, 본문의 같은 <sup>라벨</sup> 참조를 클릭형 팝오버로 연결한다.
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
    if (b.type === "footnote" && text) {
      const m = text.match(SUP_LEAD);
      if (m) {
        const label = m[1].trim();
        const html = text.slice(m[0].length).trim();
        if (!byLabel.has(label)) byLabel.set(label, { label, html });
        current = byLabel.get(label)!;
        pulled.add(b.id);
      } else if (current) {
        current.html = joinCont(current.html, text); // 마커 없는 연속분 → 병합
        pulled.add(b.id);
      }
      continue;
    }
    // 출판사 footer 잡음은 숨기되, 연속 병합은 끊지 않음(각주 절반 사이에 끼어듦)
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
