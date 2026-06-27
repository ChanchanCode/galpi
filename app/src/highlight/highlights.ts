// 키워드 형광펜 (명세 §8) — CSS Custom Highlight API 기반.
// DOM 을 변형하지 않고 Range 를 CSS.highlights 에 등록하므로 reflow(타이포 변경)에도
// 하이라이트가 텍스트에 묶여 유지된다(§8.3, §15-4).
//
// 매칭 한계(§8 한계, line 380): 블록 내 "연속 텍스트 노드 1개" 단위로만 매칭한다.
// 인라인 수식/각주 등으로 텍스트 노드가 끊긴 경계를 가로지르는 매칭은 MVP 제외.

export type HlColor = "yellow" | "green" | "blue" | "pink" | "purple";
export type HlStyle = "fill" | "underline";

export interface HighlightRule {
  id: string;
  text: string; // 정규화된 매칭 문자열(연속 공백 1개로 축약·trim)
  color: HlColor;
  style: HlStyle;
  case_sensitive: boolean;
  whole_word: boolean;
  label: string | null;
  note: string | null;
  created_at: string;
}

export const PALETTE: { key: HlColor; label: string }[] = [
  { key: "yellow", label: "노랑" },
  { key: "green", label: "초록" },
  { key: "blue", label: "파랑" },
  { key: "pink", label: "분홍" },
  { key: "purple", label: "보라" },
];

// CSS.highlights 등록 키 = ::highlight(<key>) 와 일치해야 함. styles.css 에 정적 정의.
export function hlKey(color: HlColor, style: HlStyle): string {
  return `hl-${color}-${style}`;
}

// 매칭용 정규화: 연속 공백 → 단일 공백, 양끝 trim. (개행/탭 포함)
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function isHighlightSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 규칙 → 정규식. 정규화된 텍스트의 공백은 \s+ 로(원문 공백·개행 차이 흡수).
function ruleRegex(rule: HighlightRule): RegExp | null {
  const norm = normalizeText(rule.text);
  if (!norm) return null;
  let pat = escapeRegExp(norm).replace(/\\?\s+/g, "\\s+");
  if (rule.whole_word) pat = `(?<![\\p{L}\\p{N}_])(?:${pat})(?![\\p{L}\\p{N}_])`;
  const flags = "gu" + (rule.case_sensitive ? "" : "i");
  try {
    return new RegExp(pat, flags);
  } catch {
    return null;
  }
}

const OUR_KEYS: Set<string> = new Set();

/**
 * 활성 규칙들로 container 안의 텍스트를 매칭해 CSS.highlights 에 등록한다.
 * @returns 규칙 id → 출현 횟수 (관리 패널 표시용)
 */
export function applyHighlights(
  container: HTMLElement,
  rules: HighlightRule[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!isHighlightSupported()) return counts;

  // 이전에 우리가 등록한 키 제거(검색 등 다른 기능의 하이라이트는 보존)
  for (const k of OUR_KEYS) CSS.highlights.delete(k);
  OUR_KEYS.clear();

  if (!rules.length) return counts;

  // 컴파일된 규칙 + 키별 Range 버킷
  const compiled = rules
    .map((r) => ({ rule: r, re: ruleRegex(r), key: hlKey(r.color, r.style) }))
    .filter((c) => c.re);
  if (!compiled.length) return counts;
  for (const c of compiled) counts[c.rule.id] = 0;

  const buckets = new Map<string, Range[]>();

  // 텍스트 노드 순회 — KaTeX 렌더 내부/숨김 영역은 건너뜀
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue;
      if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
      const el = node.parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      if (el.closest(".katex, .katex-display, script, style")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue!;
    for (const c of compiled) {
      c.re!.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = c.re!.exec(text))) {
        const start = m.index;
        const end = start + m[0].length;
        if (end === start) {
          c.re!.lastIndex++;
          continue;
        }
        const range = document.createRange();
        try {
          range.setStart(node, start);
          range.setEnd(node, end);
        } catch {
          continue;
        }
        let arr = buckets.get(c.key);
        if (!arr) buckets.set(c.key, (arr = []));
        arr.push(range);
        counts[c.rule.id] = (counts[c.rule.id] ?? 0) + 1;
      }
    }
  }

  for (const [key, ranges] of buckets) {
    CSS.highlights.set(key, new Highlight(...ranges));
    OUR_KEYS.add(key);
  }
  return counts;
}

/** 우리가 등록한 모든 하이라이트 제거(문서 닫을 때). */
export function clearHighlights(): void {
  if (!isHighlightSupported()) return;
  for (const k of OUR_KEYS) CSS.highlights.delete(k);
  OUR_KEYS.clear();
}

/** container 안에서 규칙의 첫 출현 Range 를 찾는다(패널 점프용). */
export function firstMatchRange(container: HTMLElement, rule: HighlightRule): Range | null {
  const re = ruleRegex(rule);
  if (!re) return null;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!node.nodeValue?.trim() || !el) return NodeFilter.FILTER_REJECT;
      if (el.closest(".katex, .katex-display")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode())) {
    re.lastIndex = 0;
    const m = re.exec(node.nodeValue!);
    if (m) {
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      return range;
    }
  }
  return null;
}
