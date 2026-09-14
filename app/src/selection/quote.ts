// 선택 → 채팅 인용(ChatQuote). 선택 툴바·텍스트 끌기·그림/표 메뉴가 같이 쓴다. DOM 만 읽는다(React 없음).
//
// 선택이 머무르는 "영역"은 넷이다 — 리플로우 원문 / 리플로우 번역 컬럼 / 원본 모드 쪽별 번역 카드 /
// 원본 지면 텍스트층. 한 선택은 **한 영역 안**에서만 유효하다(SPEC §2.3). 영역을 넘은 선택은
// 원문+한국어가 섞여 인용·형광펜·메모 어느 쪽에도 쓸 수 없다.
// 예외: 지면 텍스트층은 쪽을 넘어 이어 고를 수 있다(문단이 쪽을 넘는다 · SourceView 의 덮개 기법이 이를 전제한다).
// 그래서 텍스트층의 경계(scope)는 원본 캔버스 전체이고, 글자는 줄(.src-tl-line)에서만 모은다 — 사이의 번역 카드는 안 섞인다.
import type { ChatAttachment, ChatQuote } from "../../electron/preload";
import { attachmentFromAsset } from "../chat/chatBus";

export const SEL_REGION = ".reader-content, .tr-col, .trscroll, .src-textlayer";
export const QUOTE_MAX = 4000;

export function elOf(n: Node | null | undefined): Element | null {
  if (!n) return null;
  return n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
}

/** 노드가 속한 선택 영역. 채팅 패널 안(답변 Markdown 등)은 영역이 아니다. */
export function regionOf(n: Node | null | undefined): HTMLElement | null {
  const el = elOf(n);
  if (!el || el.closest(".chat-panel")) return null;
  return el.closest<HTMLElement>(SEL_REGION);
}

const PAGE_SCOPE = ".src-canvas";

/** 선택이 넘지 말아야 할 경계. 지면 텍스트층이면 원본 캔버스 전체, 나머지는 영역 자신. */
export function selScope(region: HTMLElement): HTMLElement {
  return region.matches(".src-textlayer") ? region.closest<HTMLElement>(PAGE_SCOPE) ?? region : region;
}

export function sameScope(a: HTMLElement | null, b: HTMLElement | null): boolean {
  return !!a && !!b && selScope(a) === selScope(b);
}

export function originOf(region: Element): ChatQuote["origin"] {
  if (region.matches(".src-textlayer")) return "page";
  if (region.matches(".tr-col, .trscroll")) return "translation";
  return "source";
}

/**
 * 현재 선택을 누른 영역(지면이면 원본 캔버스) 안으로 자른다. 방향(anchor 쪽)은 유지한다.
 * 드래그 중엔 CSS 잠금(selection.css `body.sel-lock`)이 시각적으로 막고, 손을 뗀 뒤 이걸로 실제 Range 를 맞춘다
 * — Blink 는 선택 불가 영역 글자 위에서 놓아도 끝점을 거기 둔다(실측). 끝점이 영역 밖이면
 * 형광펜·메모·번역의 `container.contains(commonAncestor)` 검사가 조용히 실패한다.
 */
export function clampSelectionTo(pressed: HTMLElement): void {
  const scope = selScope(pressed);
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return;
  const r = sel.getRangeAt(0);
  if (!r.intersectsNode(scope)) return;
  const nr = r.cloneRange();
  if (!scope.contains(nr.startContainer)) nr.setStart(scope, 0);
  if (!scope.contains(nr.endContainer)) nr.setEnd(scope, scope.childNodes.length);
  if (scope !== pressed) {
    // 지면: 끝점이 텍스트층 밖(쪽 사이 번역 카드·여백)이면 걸친 첫/마지막 층의 경계로 당긴다.
    const layers = Array.from(scope.querySelectorAll(".src-textlayer")).filter((l) => nr.intersectsNode(l));
    if (!layers.length) return sel.removeAllRanges();
    if (!elOf(nr.startContainer)?.closest(".src-textlayer")) nr.setStart(layers[0], 0);
    const last = layers[layers.length - 1];
    if (!elOf(nr.endContainer)?.closest(".src-textlayer")) nr.setEnd(last, last.childNodes.length);
  }
  if (nr.compareBoundaryPoints(Range.START_TO_START, r) === 0 && nr.compareBoundaryPoints(Range.END_TO_END, r) === 0) return;
  if (nr.collapsed) return sel.removeAllRanges();
  const backward = sel.anchorNode === r.endContainer && sel.anchorOffset === r.endOffset;
  if (backward) sel.setBaseAndExtent(nr.endContainer, nr.endOffset, nr.startContainer, nr.startOffset);
  else sel.setBaseAndExtent(nr.startContainer, nr.startOffset, nr.endContainer, nr.endOffset);
}

// ── Range → 텍스트 ────────────────────────────────────────────────
// Selection.toString() 을 쓰지 않는다: KaTeX 는 MathML 사본까지 글자로 나와 "αβα β" 처럼 겹친다.
// 조각을 복제해 수식은 TeX 주석($…$)으로 바꾸고, 블록 경계엔 줄바꿈을 넣는다.
const BLOCK_TAG = /^(P|DIV|H[1-6]|UL|OL|FIGURE|FIGCAPTION|TABLE|THEAD|TBODY|BLOCKQUOTE|DETAILS|SUMMARY|SECTION|ARTICLE|ASIDE)$/;

function walk(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.nodeValue ?? "");
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  let block = false;
  let line = false;
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    if (el.classList.contains("katex")) {
      const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (tex != null) {
        const display = !!el.closest(".katex-display");
        out.push(display ? `\n$$${tex.trim()}$$\n` : `$${tex.trim()}$`);
        return;
      }
    }
    if (el.tagName === "BR") {
      out.push("\n");
      return;
    }
    // 수식 번호 사본(좌측 균형용)·경고 점·표 토글 버튼 같은 장식은 인용에서 뺀다.
    if (el.matches('script, style, button, .katex-mathml, .formula-warn, [aria-hidden="true"]')) return;
    block = BLOCK_TAG.test(el.tagName) || el.hasAttribute("data-block-id");
    // 표 행·목록 항목·지면 줄은 한 줄 바꿈만(앞뒤로 넣으면 행 사이가 빈 줄로 벌어진다).
    line = el.tagName === "TR" || el.tagName === "LI" || el.classList.contains("src-tl-line");
    if (line) block = false;
  }
  if (block) out.push("\n");
  for (let c = node.firstChild; c; c = c.nextSibling) walk(c, out);
  if (node.nodeType === Node.ELEMENT_NODE) {
    const tag = (node as Element).tagName;
    if (tag === "TD" || tag === "TH") out.push("\t");
  }
  if (block || line) out.push("\n");
}

export function rangeText(range: Range): string {
  const r = range.cloneRange();
  // 수식 중간에서 시작·끝나면 수식 전체로 넓힌다 — 반쪽 복제는 TeX 주석을 잃는다.
  const ks = elOf(r.startContainer)?.closest(".katex");
  if (ks) r.setStartBefore(ks);
  const ke = elOf(r.endContainer)?.closest(".katex");
  if (ke) r.setEndAfter(ke);
  const out: string[] = [];
  walk(r.cloneContents(), out);
  return out.join("");
}

export function normalizeQuote(raw: string, origin: ChatQuote["origin"]): string {
  let t = raw.replace(/\u00a0/g, " ");
  if (origin === "page") {
    // 지면 텍스트층은 줄 단위다 — 줄 끝 하이픈 분철을 잇고 줄바꿈은 공백으로.
    t = t.replace(/-[ \t]*\n\s*(?=\p{Ll})/gu, "").replace(/\s*\n\s*/g, " ");
  }
  t = t
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim();
  return t.length > QUOTE_MAX ? t.slice(0, QUOTE_MAX - 1).trimEnd() + "…" : t;
}

function realBlockId(id: string | undefined | null): string | undefined {
  // 각주 목록의 `fn-<label>` 은 렌더용 가짜 id — 문서 블록이 아니다.
  return id && !id.startsWith("fn-") ? id : undefined;
}

/** Range 가 걸친 첫 요소(sel) — 시작점의 조상에서 먼저 찾고, 없으면(요소 단위 경계) 영역을 훑는다. */
function firstHit(range: Range, region: Element, sel: string): Element | null {
  const near = elOf(range.startContainer)?.closest(sel);
  if (near && region.contains(near)) return near;
  for (const el of region.querySelectorAll(sel)) if (range.intersectsNode(el)) return el;
  return null;
}

// 지면: 범위에 걸친 줄의 겹친 부분만 줄 순서대로. 쪽 사이 번역 카드·쪽 번호는 줄이 아니라 빠진다.
function pageText(range: Range, scope: Element): string {
  const out: string[] = [];
  for (const line of scope.querySelectorAll(".src-tl-line")) {
    if (!range.intersectsNode(line)) continue;
    const r = document.createRange();
    r.selectNodeContents(line);
    if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
    const t = r.toString();
    if (t) out.push(t);
  }
  return out.join("\n");
}

/** region = 시작점의 영역(지면이면 시작 쪽의 텍스트층). */
export function quoteFromRange(range: Range, region: HTMLElement): ChatQuote | null {
  const origin = originOf(region);
  const scope = selScope(region);
  const text = normalizeQuote(origin === "page" ? pageText(range, scope) : rangeText(range), origin);
  if (!text) return null;
  const q: ChatQuote = { text, origin };
  if (origin === "source") {
    q.blockId = realBlockId((firstHit(range, region, "[data-block-id]") as HTMLElement | null)?.dataset.blockId);
  } else if (origin === "translation") {
    q.blockId = (firstHit(range, region, "[data-tr-for]") as HTMLElement | null)?.dataset.trFor || undefined;
  } else {
    const page = Number(region.dataset.page);
    if (Number.isFinite(page)) q.page = page;
    q.blockId = (firstHit(range, scope, ".src-tl-line[data-block-id]") as HTMLElement | null)?.dataset.blockId || undefined;
  }
  if (!q.blockId) delete q.blockId;
  return q;
}

export interface SelectionQuote {
  quote: ChatQuote;
  range: Range;
  /** 시작점의 영역 */
  region: HTMLElement;
}

/** 현재 선택 → 인용. 영역 하나(지면이면 원본 캔버스) 안에 있고 minLen 자 이상일 때만. */
export function readSelectionQuote(minLen = 2): SelectionQuote | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const region = regionOf(range.startContainer);
  const endRegion = regionOf(range.endContainer);
  if (!region || !endRegion || originOf(region) !== originOf(endRegion) || !sameScope(region, endRegion)) return null;
  const quote = quoteFromRange(range, region);
  if (!quote || quote.text.length < minLen) return null;
  return { quote, range: range.cloneRange(), region };
}

// ── 그림 ─────────────────────────────────────────────────────────
/** `paper://doc/<docId>/<rel>`(옛 형식 `paper://<docId>/<rel>` 포함) → {docId, rel}. 해석 못 하면 null. */
export function parsePaperUrl(src: string | null | undefined): { docId: string; rel: string } | null {
  const s = (src ?? "").trim();
  try {
    const n = /^paper:\/\/doc\/([^/?#]+)\/([^?#]+)/i.exec(s);
    if (n) return { docId: decodeURIComponent(n[1]), rel: n[2].split("/").map(decodeURIComponent).join("/") };
    const m = /^paper:\/\/([^/?#]+)\/([^?#]+)/i.exec(s);
    if (m) return { docId: m[1], rel: decodeURIComponent(m[2]) };
  } catch {
    /* 잘못된 % 인코딩 */
  }
  return null;
}

/** `paper://…` → rel. 문서 폴더 밖을 가리키는 경로(`..`)는 거절. */
export function assetRelFromSrc(src: string | null | undefined, docId?: string): string | null {
  const p = parsePaperUrl(src);
  if (!p) return null;
  if (docId && p.docId.toLowerCase() !== docId.toLowerCase()) return null;
  const rel = p.rel;
  if (!rel || rel.startsWith("/") || rel.split(/[\\/]/).some((s) => s === ".." || s === "")) return null;
  return rel;
}

/** 본문 그림 <img> → 첨부 메타(복사 없이 assets 참조). */
export function attachmentFromImg(img: HTMLImageElement, docId?: string): ChatAttachment | null {
  const rel = assetRelFromSrc(img.getAttribute("src"), docId);
  if (!rel) return null;
  const blockId = realBlockId(img.closest<HTMLElement>("[data-block-id]")?.dataset.blockId);
  return attachmentFromAsset(rel, blockId);
}

export const MIME_QUOTE = "application/x-galpi-quote";
export const MIME_ATTACH = "application/x-galpi-attach";

// ── 본문 기능 호출 ────────────────────────────────────────────────
// 툴바는 형광펜·메모·번역을 직접 구현하지 않는다. 각 레이어가 이 이벤트를 받아 **키 입력과 같은 경로**로
// 현재 선택을 처리한다 — 규칙(색 순환·기존 메모 편집·잡 취소)이 두 벌이 되지 않게.
export const GALPI_ACTION = "galpi:action";
export type GalpiActionId = "highlightPassage" | "highlight" | "note" | "translate";
export interface GalpiAction {
  id: GalpiActionId;
  /** 형광펜만: 순환 대신 이 색으로(같은 색이면 해제) */
  color?: "yellow" | "green" | "blue" | "pink" | "purple";
}

export function emitAction(a: GalpiAction): void {
  window.dispatchEvent(new CustomEvent<GalpiAction>(GALPI_ACTION, { detail: a }));
}

export function onAction(cb: (a: GalpiAction) => void): () => void {
  const h = (ev: Event) => {
    const d = (ev as CustomEvent<GalpiAction>).detail;
    if (d && typeof d.id === "string") cb(d);
  };
  window.addEventListener(GALPI_ACTION, h);
  return () => window.removeEventListener(GALPI_ACTION, h);
}
