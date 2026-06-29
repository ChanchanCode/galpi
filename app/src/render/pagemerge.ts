// 페이지 경계에서 끊긴 문단 잇기.
// MinerU 는 페이지별로 블록을 만들어, 한 문단이 페이지를 넘기면 두 블록으로 쪼개진다
// (예: "…to mitigate the" | "challenges of identifying…"). 이를 자연스럽게 한 문단으로 합친다.
// 보수적으로: 페이지 경계 + 앞 문단이 문장 미완(.?! 로 안 끝남) + 뒤가 소문자/숫자로 시작할 때만.
// 각주(footnotes.pulled)·프론트매터는 hidden 으로 받아 '사이에 끼어 있어도' 건너뛰고 인접 판정.
import type { Block } from "../types";
import { isSpacedLabel } from "./frontmatter";

const ENDS_SENTENCE = /[.?!]["'’”)\]]*$/; // 문장 종료(닫는 따옴표/괄호 포함)
const STARTS_CONT = /^\s*["'(“]?[a-z0-9]/; // 이어지는 조각: 소문자/숫자(여는 따옴표/괄호 허용)

export interface PageMerge {
  absorbed: Set<string>; // 합쳐져 숨길 블록 id
  textOverride: Map<string, string>; // 기준 블록 id → 합쳐진 본문
}

export const EMPTY_PAGE_MERGE: PageMerge = { absorbed: new Set(), textOverride: new Map() };

function joinPage(a: string, b: string): string {
  const aa = a.replace(/\s+$/, "");
  const bb = b.replace(/^\s+/, "");
  if (/[A-Za-z]-$/.test(aa)) return aa.slice(0, -1) + bb; // 줄끝 하이픈으로 끊긴 단어는 붙임
  return aa + " " + bb;
}

export function buildPageMerges(blocks: Block[], hidden: Set<string>): PageMerge {
  const absorbed = new Set<string>();
  const textOverride = new Map<string, string>();
  let baseId: string | null = null;
  let basePage: number | null = null;
  let baseText = "";
  for (const b of blocks) {
    if (hidden.has(b.id) || isSpacedLabel(b.text)) continue; // 각주/프론트매터/장식라벨 → 연결만 유지
    if (b.type !== "paragraph") { baseId = null; continue; } // 문단끼리만 병합
    const text = b.text ?? "";
    if (
      baseId &&
      basePage != null &&
      b.page !== basePage && // 페이지 경계
      !ENDS_SENTENCE.test(baseText.trimEnd()) && // 앞 문단이 문장 미완
      STARTS_CONT.test(text) // 뒤가 이어지는 모양
    ) {
      baseText = joinPage(baseText, text);
      textOverride.set(baseId, baseText);
      absorbed.add(b.id);
      basePage = b.page; // 3페이지 연속 분리도 계속 이어붙이기
      continue;
    }
    baseId = b.id;
    basePage = b.page;
    baseText = text;
  }
  return { absorbed, textOverride };
}
