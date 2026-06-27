// 섹션 이동 — 스크롤 옆 위치 눈금(항상 고정 표시) + 버튼/단축키로 여는 목차 사이드 패널.
// (호버로 떴다 사라지던 플라이아웃은 직관적이지 않다는 피드백으로 제거. 패널은 형광펜 패널과 동일 패턴.)
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { jumpWith } from "../nav/jump";

const SCROLL_SEL = ".reader-scroll";
const CONTENT_SEL = ".reader-content";

interface Section {
  id: string;
  label: string;
  level: number;
  top: number; // 스크롤 컨테이너 기준 콘텐츠 오프셋(px)
  ratio: number; // top / scrollHeight (눈금 세로 위치)
}

interface Props {
  docId: string;
  blockCount: number;
  panelOpen: boolean;
  onClose: () => void;
}

export function SectionRail({ docId, blockCount, panelOpen, onClose }: Props) {
  const typography = useStore((s) => s.typography); // 레이아웃 바뀌면 재측정
  const [secs, setSecs] = useState<Section[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const secsRef = useRef<Section[]>([]);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const measure = useCallback(() => {
    const scroller = document.querySelector(SCROLL_SEL) as HTMLElement | null;
    const content = document.querySelector(CONTENT_SEL) as HTMLElement | null;
    if (!scroller || !content) return;
    const sRect = scroller.getBoundingClientRect();
    const total = scroller.scrollHeight || 1;
    const heads = Array.from(content.querySelectorAll<HTMLElement>(".blk-heading"));
    const list: Section[] = heads
      .map((h) => {
        const rect = h.getBoundingClientRect();
        if (rect.height === 0) return null; // 접힌 frontmatter 등 숨겨진 헤딩 제외
        const top = rect.top - sRect.top + scroller.scrollTop;
        return {
          id: h.dataset.blockId ?? "",
          label: (h.textContent ?? "").trim().replace(/\s+/g, " "),
          level: Number(h.tagName.slice(1)) || 2,
          top,
          ratio: Math.min(1, Math.max(0, top / total)),
        };
      })
      .filter((s): s is Section => !!s && !!s.id && !!s.label);
    secsRef.current = list;
    setSecs(list);
  }, []);

  const updateActive = useCallback(() => {
    const scroller = document.querySelector(SCROLL_SEL) as HTMLElement | null;
    if (!scroller) return;
    const list = secsRef.current;
    const max = scroller.scrollHeight - scroller.clientHeight;
    setProgress(max > 0 ? scroller.scrollTop / max : 0);
    const y = scroller.scrollTop + scroller.clientHeight * 0.28; // 화면 상단부 기준
    let cur: string | null = list[0]?.id ?? null;
    for (const s of list) {
      if (s.top <= y) cur = s.id;
      else break;
    }
    setActive(cur);
  }, []);

  // 측정: 마운트 + 문서/블록수/타이포 변경
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      measure();
      updateActive();
    });
    return () => cancelAnimationFrame(raf);
  }, [measure, updateActive, docId, blockCount, typography]);

  // 리사이즈 + 콘텐츠 크기 변화 재측정
  useEffect(() => {
    const content = document.querySelector(CONTENT_SEL);
    const onResize = () => {
      measure();
      updateActive();
    };
    window.addEventListener("resize", onResize);
    const ro = content ? new ResizeObserver(onResize) : null;
    if (content) ro!.observe(content);
    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, [measure, updateActive, docId]);

  // 스크롤 추적(rAF 스로틀)
  useEffect(() => {
    const scroller = document.querySelector(SCROLL_SEL) as HTMLElement | null;
    if (!scroller) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        updateActive();
        ticking = false;
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [updateActive, docId]);

  // 패널 열려 있으면 현재 섹션이 목록에서 보이도록 스크롤
  useEffect(() => {
    if (panelOpen && activeRef.current) {
      activeRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [active, panelOpen]);

  const jump = (s: Section) => {
    const scroller = document.querySelector(SCROLL_SEL) as HTMLElement | null;
    if (!scroller) return;
    const el = document.querySelector(`[data-block-id="${s.id}"]`) as HTMLElement | null;
    jumpWith(el, () => scroller.scrollTo({ top: Math.max(0, s.top - 16), behavior: "smooth" }));
  };

  const hasSecs = secs.length >= 2;
  if (!hasSecs && !panelOpen) return null;

  return (
    <>
      {/* 스크롤 옆 위치 눈금 — 항상 고정 표시(시각 표시 전용) */}
      {hasSecs && (
        <div className="section-minimap" aria-hidden="true">
          <div className="section-progress" style={{ top: `${progress * 100}%` }} />
          {secs.map((s) => (
            <span
              key={s.id}
              className={`section-tick lvl-${Math.min(s.level, 3)} ${active === s.id ? "active" : ""}`}
              style={{ top: `${s.ratio * 100}%` }}
            />
          ))}
        </div>
      )}

      {/* 목차 사이드 패널 — 버튼/단축키로 토글 */}
      {panelOpen && (
        <aside className="section-panel" onMouseDown={(e) => e.stopPropagation()}>
          <div className="section-panel-head">
            <span>목차 {hasSecs && `(${secs.length})`}</span>
            <button className="icon-btn" onClick={onClose} aria-label="닫기">✕</button>
          </div>
          {!hasSecs ? (
            <p className="section-empty">이 문서에서 섹션(제목)을 찾지 못했습니다.</p>
          ) : (
            <ul className="section-panel-list">
              {secs.map((s) => (
                <li key={s.id}>
                  <button
                    ref={active === s.id ? activeRef : undefined}
                    className={`section-item lvl-${Math.min(s.level, 3)} ${active === s.id ? "active" : ""}`}
                    onClick={() => jump(s)}
                    title={s.label}
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}
    </>
  );
}
