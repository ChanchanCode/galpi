// 문장 호버 연결의 좌표 변환 (PLAN-AI D13 · §7.4).
//
// 모델이 돌려준 span 은 **원문 문자열(block.text) 기준 오프셋**이다. 화면의 DOM 은 그 문자열이
// 아니다 — $...$ 는 KaTeX 글리프로 바뀌고, <sup> 태그는 사라지고, Bionic 모드는 단어 하나를
// <b>con</b>ducted 처럼 텍스트 노드 두 개로 쪼갠다. 오프셋을 그대로 쓰면 어긋난다.
//
// 그래서 **단어 수열 정렬**로 푼다:
//   1) 원문에서 화면에 안 보이는 부분(수식·태그 마크업)을 같은 길이 공백으로 지운다 → 오프셋 보존
//   2) DOM 텍스트 노드를 이어붙여 평문 하나로 만들되 글자마다 (노드, 오프셋)을 기억한다
//      → Bionic 이 쪼갠 조각이 다시 한 단어로 붙는다
//   3) 두 단어열을 그리디 정렬(작은 창 안에서 앞뒤로 찾기)
// 수식 단어는 양쪽 모두에서 빠지므로 자연히 건너뛰어진다.

interface Word {
  w: string;
  s: number;
  e: number;
}

const WORD_RE = /[\p{L}\p{N}]+/gu;

// D22 — 마스킹 정규식은 파이프라인·RichText 와 **같은 패턴**이어야 한다.
// 안 맞추면 `\$17.00` 같은 실데이터에서 산문을 수식으로 보고 앵커가 통째로 밀린다.
const MATH_RE = /(?<!\\)\$.+?(?<!\\)\$/g;
const TAG_RE = /<\/?[A-Za-z][^>]*>/g;

// 길이를 유지한 채 지운다 — 오프셋이 원문과 1:1 로 남아야 한다.
function blankOut(src: string): string {
  const blank = (m: string) => " ".repeat(m.length);
  return src.replace(MATH_RE, blank).replace(TAG_RE, blank);
}

function wordsOf(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const s = m.index ?? 0;
    out.push({ w: m[0].toLowerCase(), s, e: s + m[0].length });
  }
  return out;
}

interface Flat {
  text: string;
  node: Text[]; // 글자 i 가 속한 텍스트 노드
  off: number[]; // 글자 i 의 그 노드 안 오프셋
  start: Map<Text, number>; // 노드 → 평문에서의 시작 위치(역방향 조회용)
}

// KaTeX 렌더 결과는 원문 글자가 아니다 → 제외. 각주 <sup> 라벨과 상호참조 링크는
// 원문에도 같은 글자가 있으므로 **제외하지 않는다**(빼면 정렬이 밀린다).
const SKIP_SEL = ".katex, .katex-display, script, style";

function flatten(root: HTMLElement): Flat {
  const node: Text[] = [];
  const off: number[] = [];
  const start = new Map<Text, number>();
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const el = n.parentElement;
      if (!n.nodeValue || !el) return NodeFilter.FILTER_REJECT;
      if (el.closest(SKIP_SEL)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const v = t.nodeValue ?? "";
    start.set(t, text.length);
    for (let i = 0; i < v.length; i++) {
      node.push(t);
      off.push(i);
    }
    text += v;
  }
  return { text, node, off, start };
}

// 그리디 정렬. 두 열은 거의 같으므로 좁은 창(LOOK)만 봐도 충분하다.
// 대각선 순서로 탐색해 한쪽만 길게 건너뛰는 일을 막는다.
const LOOK = 10;
function greedyAlign(a: Word[], b: Word[]): (number | null)[] {
  const map: (number | null)[] = new Array(a.length).fill(null);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].w === b[j].w) {
      map[i] = j;
      i += 1;
      j += 1;
      continue;
    }
    let hi = -1;
    let hj = -1;
    search: for (let d = 1; d <= LOOK; d++) {
      for (let k = 0; k <= d; k++) {
        const ii = i + k;
        const jj = j + (d - k);
        if (ii < a.length && jj < b.length && a[ii].w === b[jj].w) {
          hi = ii;
          hj = jj;
          break search;
        }
      }
    }
    if (hi < 0) {
      i += 1;
      j += 1;
    } else {
      i = hi;
      j = hj;
    }
  }
  return map;
}

export interface Alignment {
  /** 원문 오프셋 구간 → 화면 Range. 앵커를 못 찾으면 null. */
  rangeFor(start: number, end: number): Range | null;
  /** 화면 좌표(노드·오프셋) → 원문 오프셋. 못 찾으면 null. */
  srcOffsetAt(node: Node, offset: number): number | null;
  /** 정렬된 단어 비율 — 0 에 가까우면 이 블록의 호버 연결을 포기하는 편이 낫다. */
  coverage: number;
}

export function alignBlock(el: HTMLElement, src: string): Alignment {
  const sw = wordsOf(blankOut(src));
  const flat = flatten(el);
  const dw = wordsOf(flat.text);
  const s2d = greedyAlign(sw, dw);
  const d2s = new Map<number, number>();
  s2d.forEach((d, s) => {
    if (d != null && !d2s.has(d)) d2s.set(d, s);
  });
  const matched = s2d.reduce<number>((n, x) => n + (x == null ? 0 : 1), 0);

  function rangeFor(start: number, end: number): Range | null {
    if (!(end > start) || !sw.length) return null;
    // 구간에 걸치는 원문 단어들 중, 실제로 화면에 매칭된 처음/마지막을 쓴다.
    let a = -1;
    let b = -1;
    for (let i = 0; i < sw.length; i++) {
      if (sw[i].e <= start || sw[i].s >= end) continue;
      if (s2d[i] == null) continue;
      if (a < 0) a = i;
      b = i;
    }
    if (a < 0) return null;
    const d0 = s2d[a]!;
    const d1 = s2d[b]!;
    if (d1 < d0) return null;
    const cs = dw[d0].s;
    const ce = dw[d1].e;
    if (!(ce > cs) || ce > flat.node.length) return null;
    const r = document.createRange();
    try {
      r.setStart(flat.node[cs], flat.off[cs]);
      r.setEnd(flat.node[ce - 1], flat.off[ce - 1] + 1);
    } catch {
      return null;
    }
    return r;
  }

  function srcOffsetAt(node: Node, offset: number): number | null {
    const base = flat.start.get(node as Text);
    if (base == null) return null;
    const idx = base + offset;
    // idx 를 품은 DOM 단어 찾기(이분 탐색)
    let lo = 0;
    let hi = dw.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dw[mid].e <= idx) lo = mid + 1;
      else if (dw[mid].s > idx) hi = mid - 1;
      else {
        hit = mid;
        break;
      }
    }
    if (hit < 0) hit = Math.min(lo, dw.length - 1); // 공백 위 → 다음 단어로 붙인다
    if (hit < 0) return null;
    const s = d2s.get(hit);
    return s == null ? null : sw[s].s;
  }

  return { rangeFor, srcOffsetAt, coverage: sw.length ? matched / sw.length : 0 };
}
