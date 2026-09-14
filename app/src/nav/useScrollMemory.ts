// 읽던 위치 기억 — 문서를 다시 열면 마지막 스크롤 위치로 복원.
// 절대 px 대신 "화면 최상단 블록 id + 블록 내 진행률"을 저장해
// 타이포 변경(reflow)·창 크기 변화에도 같은 문장 근처로 돌아온다.
// state.json 에 scroll_anchor 로 병합 저장(와처 밖이라 재로드 유발 없음).
import { useEffect } from "react";

interface ScrollAnchor {
  block: string; // 빈 문자열 = 문서 맨 위
  frac: number; // 블록 상단이 화면 위로 밀려난 비율 (0~1)
}

const SCROLLER_SEL = ".reader-scroll";

export function useScrollMemory(docId: string | null) {
  useEffect(() => {
    if (!docId) return;
    const sc = document.querySelector(SCROLLER_SEL) as HTMLElement | null;
    if (!sc) return;
    let disposed = false;
    let ready = false; // 복원 전 스크롤 이벤트가 앵커를 덮어쓰지 않게
    let timer: ReturnType<typeof setTimeout> | null = null;

    const currentAnchor = (): ScrollAnchor | null => {
      if (sc.scrollTop <= 1) return { block: "", frac: 0 };
      const scTop = sc.getBoundingClientRect().top;
      // 리플로우 본문 블록만 — 원본 모드 지면 텍스트층 줄(.src-tl-line)도 data-block-id 를 달지만 앵커로 쓰면 복원 위치가 어긋난다.
      for (const el of sc.querySelectorAll<HTMLElement>(".reader-content [data-block-id]")) {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.bottom > scTop + 1) {
          return { block: el.dataset.blockId!, frac: Math.min(1, Math.max(0, (scTop - r.top) / r.height)) };
        }
      }
      return null;
    };

    const persist = () => {
      const a = currentAnchor();
      if (a) void window.paperAPI.updateReading(docId, { scroll_anchor: a });
    };

    const onScroll = () => {
      if (!ready) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        persist();
      }, 600);
    };

    (async () => {
      const st = (await window.paperAPI.loadState(docId)) as { scroll_anchor?: ScrollAnchor } | null;
      if (disposed) return;
      const a = st?.scroll_anchor;
      if (a?.block) {
        const el = sc.querySelector<HTMLElement>(`.reader-content [data-block-id="${CSS.escape(a.block)}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          sc.scrollTop += r.top - sc.getBoundingClientRect().top + r.height * a.frac;
        }
      }
      ready = true;
    })();

    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      disposed = true;
      sc.removeEventListener("scroll", onScroll);
      if (timer) {
        clearTimeout(timer); // 디바운스 중이던 마지막 위치를 즉시 커밋
        if (ready) persist();
      }
    };
  }, [docId]);
}
