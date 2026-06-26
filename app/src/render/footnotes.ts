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
  pulled: Set<string>; // 본문 흐름에서 제거할 각주 블록 id
  ordered: Footnote[]; // 표시 순서(숫자 우선, 그다음 기호)
}

const SUP_LEAD = /^\s*<sup>(.+?)<\/sup>\s*/i;

export function buildFootnotes(blocks: Block[]): FootnoteData {
  const byLabel = new Map<string, Footnote>();
  const pulled = new Set<string>();
  for (const b of blocks) {
    if (b.type !== "footnote" || !b.text) continue;
    const m = b.text.match(SUP_LEAD);
    if (!m) continue; // 마커 없는 footnote(연속/본문 오분류)는 그대로 둠
    const label = m[1].trim();
    const html = b.text.slice(m[0].length).trim();
    if (!byLabel.has(label)) byLabel.set(label, { label, html });
    pulled.add(b.id);
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
