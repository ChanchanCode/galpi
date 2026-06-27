// 포커스 모드 (§11-9, 확장) — 문단/문장 단위로 한 곳만 또렷, 나머지 흐리게.
//  · 문단: 활성 블록만 또렷(나머지 opacity↓)
//  · 문장: 본문 전체 흐리게 + 활성 문장만 CSS Custom Highlight 로 또렷
//  · ←/→ 로 이전/다음 단위로 포커스 이동 + 화면 가운데로 스크롤
import { useEffect, useRef } from "react";
import { splitSentences } from "../render/reading";

export type FocusKind = "off" | "paragraph" | "sentence";

interface Props {
  mode: FocusKind;
  docId: string;
  blockCount: number;
}

interface Unit {
  el: HTMLElement;
  start?: number; // 문장 모드: 블록 가시 텍스트 내 문자 오프셋
  end?: number;
}

const SCROLL_SEL = ".reader-scroll";
const CONTENT_SEL = ".reader-content";
const HL_KEY = "focus-line";

function supported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

// 블록의 "가시 텍스트 노드"(katex 등 제외) — 텍스트 합치기/Range 양쪽에서 동일 필터 사용.
function visibleTextNodes(el: HTMLElement): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = (n as Text).parentElement;
      if (!n.nodeValue || !p) return NodeFilter.FILTER_REJECT;
      if (p.closest(".katex, .katex-display, script, style")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null;
  while ((n = w.nextNode())) out.push(n as Text);
  return out;
}

function rangeForSpan(el: HTMLElement, start: number, end: number): Range | null {
  const nodes = visibleTextNodes(el);
  let acc = 0;
  let sNode: Text | null = null;
  let sOff = 0;
  let eNode: Text | null = null;
  let eOff = 0;
  for (const node of nodes) {
    const len = node.nodeValue!.length;
    if (!sNode && acc + len > start) {
      sNode = node;
      sOff = start - acc;
    }
    if (acc + len >= end) {
      eNode = node;
      eOff = end - acc;
      break;
    }
    acc += len;
  }
  if (!sNode || !eNode) return null;
  const r = document.createRange();
  try {
    r.setStart(sNode, Math.max(0, Math.min(sOff, sNode.nodeValue!.length)));
    r.setEnd(eNode, Math.max(0, Math.min(eOff, eNode.nodeValue!.length)));
  } catch {
    return null;
  }
  return r;
}

function buildUnits(mode: FocusKind, content: HTMLElement): Unit[] {
  const blocks = Array.from(content.querySelectorAll<HTMLElement>(":scope > [data-block-id]"));
  if (mode === "paragraph") return blocks.map((el) => ({ el }));
  // sentence
  const units: Unit[] = [];
  for (const el of blocks) {
    const nodes = visibleTextNodes(el);
    if (!nodes.length) continue;
    const full = nodes.map((n) => n.nodeValue).join("");
    if (full.trim().length < 2) continue;
    let off = 0;
    for (const s of splitSentences(full)) {
      if (s.trim().length >= 1) units.push({ el, start: off, end: off + s.length });
      off += s.length;
    }
  }
  return units;
}

function rectOf(u: Unit): DOMRect | null {
  if (u.start == null) return u.el.getBoundingClientRect();
  const r = rangeForSpan(u.el, u.start, u.end!);
  return r ? r.getBoundingClientRect() : u.el.getBoundingClientRect();
}

function inView(rect: DOMRect | null, scroller: HTMLElement): boolean {
  if (!rect) return false;
  const s = scroller.getBoundingClientRect();
  return rect.bottom > s.top + 8 && rect.top < s.bottom - 8;
}

export function FocusMode({ mode, docId, blockCount }: Props) {
  const unitsRef = useRef<Unit[]>([]);
  const idxRef = useRef<number>(-1);
  const prevElRef = useRef<HTMLElement | null>(null);

  // 활성 단위 표시(문단=is-focus, 문장=highlight) + 선택적 스크롤
  const apply = (idx: number, scroll: boolean) => {
    const units = unitsRef.current;
    const u = units[idx];
    if (!u) return;
    idxRef.current = idx;
    if (mode === "paragraph") {
      if (prevElRef.current && prevElRef.current !== u.el) prevElRef.current.classList.remove("is-focus");
      u.el.classList.add("is-focus");
      prevElRef.current = u.el;
      if (scroll) u.el.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      const r = rangeForSpan(u.el, u.start!, u.end!);
      if (r && supported()) CSS.highlights.set(HL_KEY, new Highlight(r));
      if (scroll && r) {
        const scroller = document.querySelector(SCROLL_SEL) as HTMLElement | null;
        const rect = r.getBoundingClientRect();
        if (scroller) {
          const sRect = scroller.getBoundingClientRect();
          const top = rect.top - sRect.top + scroller.scrollTop - scroller.clientHeight / 2 + rect.height / 2;
          scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        }
      }
    }
  };

  // 화면 중앙에 가장 가까운 단위 인덱스
  const nearestIdx = (): number => {
    const units = unitsRef.current;
    const scroller = document.querySelector(SCROLL_SEL) as HTMLElement | null;
    if (!units.length || !scroller) return 0;
    const center = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
    // 문장 모드는 블록 단위로 먼저 좁힘(비용 절감)
    if (mode === "sentence") {
      let bestEl: HTMLElement | null = null;
      let bestD = Infinity;
      const seen = new Set<HTMLElement>();
      for (const u of units) {
        if (seen.has(u.el)) continue;
        seen.add(u.el);
        const rc = u.el.getBoundingClientRect();
        const d = Math.abs(rc.top + rc.height / 2 - center);
        if (d < bestD) {
          bestD = d;
          bestEl = u.el;
        }
      }
      const i = units.findIndex((u) => u.el === bestEl);
      return i < 0 ? 0 : i;
    }
    let best = 0;
    let bestD = Infinity;
    units.forEach((u, i) => {
      const rc = u.el.getBoundingClientRect();
      const d = Math.abs(rc.top + rc.height / 2 - center);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  // 모드/문서 변경 → 단위 재구성 + body 표식 + 초기 활성(가운데)
  useEffect(() => {
    const content = document.querySelector(CONTENT_SEL) as HTMLElement | null;
    if (mode === "off" || !content) {
      delete document.body.dataset.focus;
      prevElRef.current?.classList.remove("is-focus");
      prevElRef.current = null;
      if (supported()) CSS.highlights.delete(HL_KEY);
      return;
    }
    document.body.dataset.focus = mode;
    const raf = requestAnimationFrame(() => {
      unitsRef.current = buildUnits(mode, content);
      apply(nearestIdx(), false);
    });
    return () => {
      cancelAnimationFrame(raf);
      delete document.body.dataset.focus;
      prevElRef.current?.classList.remove("is-focus");
      prevElRef.current = null;
      if (supported()) CSS.highlights.delete(HL_KEY);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, docId, blockCount]);

  // ←/→ 로 이전/다음 단위 이동 (화면 밖이면 가운데 단위에서 재시작)
  useEffect(() => {
    if (mode === "off") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const units = unitsRef.current;
      if (!units.length) return;
      e.preventDefault();
      const scroller = document.querySelector(SCROLL_SEL) as HTMLElement | null;
      let cur = idxRef.current;
      // 현재 활성 단위가 화면 밖이면 가운데 기준으로 재설정
      if (cur < 0 || (scroller && !inView(rectOf(units[cur]), scroller))) cur = nearestIdx();
      const next = Math.max(0, Math.min(units.length - 1, cur + (e.key === "ArrowRight" ? 1 : -1)));
      apply(next, true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return null;
}
