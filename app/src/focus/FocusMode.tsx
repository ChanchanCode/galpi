// 포커스 모드 (§11-9) — 화면 세로 중앙 띠에 걸친 블록만 또렷, 나머지는 흐리게.
// 순수 프론트(IntersectionObserver + CSS), 의존성 0. body[data-focus] + .is-focus 토글.
import { useEffect } from "react";

interface Props {
  active: boolean;
  docId: string;
  blockCount: number; // 스트리밍으로 블록 늘면 재관찰
}

export function FocusMode({ active, docId, blockCount }: Props) {
  useEffect(() => {
    if (!active) {
      delete document.body.dataset.focus;
      return;
    }
    document.body.dataset.focus = "on";
    const content = document.querySelector(".reader-content");
    const scroller = document.querySelector(".reader-scroll");
    if (!content) {
      return () => {
        delete document.body.dataset.focus;
      };
    }
    const els = Array.from(content.children) as HTMLElement[];
    // 중앙 ~16% 띠(위/아래 42% 잘라냄)에 걸친 요소만 intersecting → 또렷
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          (e.target as HTMLElement).classList.toggle("is-focus", e.isIntersecting);
        }
      },
      { root: scroller as Element | null, rootMargin: "-42% 0px -42% 0px", threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    return () => {
      io.disconnect();
      els.forEach((el) => el.classList.remove("is-focus"));
      delete document.body.dataset.focus;
    };
  }, [active, docId, blockCount]);

  return null;
}
