// 키워드 형광펜 (명세 §8) — CSS Custom Highlight API 기반.
// DOM 을 변형하지 않고 Range 를 CSS.highlights 에 등록하므로 reflow(타이포 변경)에도
// 하이라이트가 텍스트에 묶여 유지된다(§8.3, §15-4).
//
// 매칭 한계(§8 한계, line 380): 블록 내 "연속 텍스트 노드 1개" 단위로만 매칭한다.
// 인라인 수식/각주 등으로 텍스트 노드가 끊긴 경계를 가로지르는 매칭은 MVP 제외.

export type HlColor = "yellow" | "green" | "blue" | "pink" | "purple";
export type HlStyle = "fill" | "underline";

// 형광펜 종류:
//  - "keyword": 같은 텍스트를 문서 전체에서 전부 칠함(용어 추적). 기본/레거시.
//  - "passage": 선택한 그 부분 하나만 칠함(일반 형광펜). occurrence 로 몇 번째 출현인지 고정.
export type HlScope = "keyword" | "passage";

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
  scope?: HlScope; // 미지정(레거시) = "keyword"
  occurrence?: number; // passage 전용 — 같은 텍스트의 0-기반 출현 인덱스
}

// 레거시 규칙(scope 없음)은 키워드로 취급.
export function ruleScope(rule: HighlightRule): HlScope {
  return rule.scope ?? "keyword";
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

// 텍스트 → 정규식. 정규화된 텍스트의 공백은 \s+ 로(원문 공백·개행 차이 흡수).
function textRegex(
  text: string,
  opts: { whole_word?: boolean; case_sensitive?: boolean } = {},
): RegExp | null {
  const norm = normalizeText(text);
  if (!norm) return null;
  let pat = escapeRegExp(norm).replace(/\\?\s+/g, "\\s+");
  if (opts.whole_word) pat = `(?<![\\p{L}\\p{N}_])(?:${pat})(?![\\p{L}\\p{N}_])`;
  const flags = "gu" + (opts.case_sensitive ? "" : "i");
  try {
    return new RegExp(pat, flags);
  } catch {
    return null;
  }
}

// 규칙 → 정규식.
function ruleRegex(rule: HighlightRule): RegExp | null {
  return textRegex(rule.text, { whole_word: rule.whole_word, case_sensitive: rule.case_sensitive });
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

  // 규칙별 "지금까지 본 매치 수" — passage 의 occurrence 고정에 쓰임(렌더 여부와 무관하게 증가).
  const seen: Record<string, number> = {};
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
        // 이 텍스트의 몇 번째 출현인지(문서 순서). passage 는 지정된 occurrence 만 칠한다.
        const occIndex = seen[c.rule.id] ?? 0;
        seen[c.rule.id] = occIndex + 1;
        if (c.rule.scope === "passage" && occIndex !== (c.rule.occurrence ?? 0)) continue;
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

// applyHighlights 와 같은 텍스트 노드 필터 — occurrence 인덱스가 렌더와 일치하도록 동일 기준 사용.
function textWalker(container: HTMLElement): TreeWalker {
  return document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue;
      if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
      const el = node.parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      if (el.closest(".katex, .katex-display, script, style")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
}

// container 안에서 text 의 모든 출현 Range 를 문서 순서로 반환.
function allMatchRanges(
  container: HTMLElement,
  text: string,
  opts: { whole_word?: boolean; case_sensitive?: boolean } = {},
): Range[] {
  const re = textRegex(text, opts);
  if (!re) return [];
  const out: Range[] = [];
  const walker = textWalker(container);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const val = node.nodeValue!;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(val))) {
      const start = m.index;
      const end = start + m[0].length;
      if (end === start) {
        re.lastIndex++;
        continue;
      }
      const range = document.createRange();
      try {
        range.setStart(node, start);
        range.setEnd(node, end);
        out.push(range);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

/** 선택 Range 가 text 의 몇 번째 출현인지(0-기반). 선택 시작 앞에 끝난 매치 수로 센다. */
export function occurrenceOf(container: HTMLElement, text: string, selRange: Range): number {
  const ranges = allMatchRanges(container, text);
  let n = 0;
  for (const r of ranges) {
    // r 의 끝이 선택 시작보다 앞이면 앞선 출현.
    if (r.compareBoundaryPoints(Range.END_TO_START, selRange) <= 0) n++;
  }
  return n;
}

/** 규칙의 대상 출현 Range 를 찾는다(패널 점프용). keyword=첫 출현, passage=지정 occurrence. */
export function firstMatchRange(container: HTMLElement, rule: HighlightRule): Range | null {
  const ranges = allMatchRanges(container, rule.text, {
    whole_word: rule.whole_word,
    case_sensitive: rule.case_sensitive,
  });
  if (!ranges.length) return null;
  const idx = ruleScope(rule) === "passage" ? rule.occurrence ?? 0 : 0;
  return ranges[idx] ?? ranges[0];
}
