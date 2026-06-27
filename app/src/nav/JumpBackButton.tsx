// "원래 위치로" 돌아가기 버튼 — 점프 직후 떠 있다가, 도착지가 화면을 완전히 벗어나면 숨김.
// (그 경우엔 Cmd+Z 로 복귀 — App 에서 처리.)
import { useEffect, useState } from "react";
import { onJump, undoJump } from "./jump";

export function JumpBackButton() {
  const [destEl, setDestEl] = useState<HTMLElement | null>(null);

  useEffect(() => onJump((el) => setDestEl(el)), []);

  useEffect(() => {
    if (!destEl) return;
    const scroller = document.querySelector(".reader-scroll");
    let seen = false; // 부드러운 스크롤로 도착지가 보일 때까지 기다린 뒤부터 이탈 감지
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) seen = true;
          else if (seen) setDestEl(null); // 도착지가 화면 밖으로 완전히 벗어남 → 버튼 숨김
        }
      },
      { root: scroller as Element | null, threshold: 0 },
    );
    io.observe(destEl);
    return () => io.disconnect();
  }, [destEl]);

  if (!destEl) return null;
  return (
    <button className="jump-back" onClick={() => undoJump()} title="원래 위치로 (⌘Z)">
      ↩ 원래 위치
    </button>
  );
}
