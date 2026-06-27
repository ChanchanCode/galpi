// 본문 텍스트 검색 (Cmd+F) — CSS Custom Highlight API 로 DOM 비변형 매칭.
// 형광펜(highlights.ts)과 다른 키(search-hit / search-current)를 쓰므로 서로 간섭하지 않는다.
// 한계는 형광펜과 동일: 텍스트 노드 1개 단위 매칭(노드 경계 가로지르기 제외).

const HIT_KEY = "search-hit";
const CUR_KEY = "search-current";

export function isHighlightSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// query → 정규식. 공백은 \s+ 로(원문 개행/다중 공백 흡수).
function queryRegex(query: string, caseSensitive: boolean): RegExp | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const pat = escapeRegExp(trimmed).replace(/\s+/g, "\\s+");
  try {
    return new RegExp(pat, "g" + (caseSensitive ? "" : "i"));
  } catch {
    return null;
  }
}

// container 안에서 query 의 모든 출현을 문서 순서대로 Range 배열로 반환.
export function findMatches(container: HTMLElement, query: string, caseSensitive: boolean): Range[] {
  const re = queryRegex(query, caseSensitive);
  if (!re || !isHighlightSupported()) return [];

  const ranges: Range[] = [];
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
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
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
        ranges.push(range);
      } catch {
        /* skip */
      }
    }
  }
  return ranges;
}

// 전체 매칭 + 현재 매칭을 CSS.highlights 에 등록.
export function paintSearch(ranges: Range[], current: number): void {
  if (!isHighlightSupported()) return;
  if (!ranges.length) {
    clearSearch();
    return;
  }
  CSS.highlights.set(HIT_KEY, new Highlight(...ranges));
  const cur = ranges[current];
  if (cur) CSS.highlights.set(CUR_KEY, new Highlight(cur));
  else CSS.highlights.delete(CUR_KEY);
}

export function clearSearch(): void {
  if (!isHighlightSupported()) return;
  CSS.highlights.delete(HIT_KEY);
  CSS.highlights.delete(CUR_KEY);
}
