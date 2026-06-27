// 점프 히스토리 — 특정 위치로 이동(상호참조·목차·형광펜 등)할 때 원래 위치를 기록해
// "돌아가기" 버튼과 Cmd+Z 되돌리기를 제공한다. 버튼 표시/숨김은 JumpBackButton 이 담당.
const SCROLL_SEL = ".reader-scroll";

type JumpListener = (destEl: HTMLElement | null) => void;
const listeners = new Set<JumpListener>();
let history: number[] = []; // 원래 위치(scrollTop) 스택 — Cmd+Z 용

function scroller(): HTMLElement | null {
  return document.querySelector(SCROLL_SEL) as HTMLElement | null;
}

export function onJump(l: JumpListener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function record(): boolean {
  const sc = scroller();
  if (!sc) return false;
  history.push(sc.scrollTop);
  if (history.length > 100) history.shift();
  return true;
}

function notify(destEl: HTMLElement | null) {
  listeners.forEach((l) => l(destEl));
}

// 요소로 점프(가운데 정렬). destEl 의 화면 이탈로 버튼이 자동 숨김된다.
export function jumpToElement(el: HTMLElement | null): void {
  if (!el || !record()) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  notify(el);
}

// 커스텀 스크롤(형광펜 Range 등) — 원위치 기록 후 doScroll 실행, destEl 로 버튼 추적.
export function jumpWith(destEl: HTMLElement | null, doScroll: () => void): void {
  if (!record()) return;
  doScroll();
  notify(destEl);
}

// 가장 최근 원위치로 복귀(버튼 클릭 · Cmd+Z 공용). 화면 밖이어도 동작.
export function undoJump(): boolean {
  const sc = scroller();
  if (!sc || !history.length) return false;
  const top = history.pop()!;
  sc.scrollTo({ top, behavior: "smooth" });
  notify(null); // 버튼 숨김
  return true;
}

export function resetJumpHistory(): void {
  history = [];
  notify(null);
}
