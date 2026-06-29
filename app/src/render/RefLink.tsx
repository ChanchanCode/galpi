// 상호참조 마커 (§11-7) — 1초 호버 시 프리뷰 팝오버, 클릭 시 해당 블록으로 이동.
// 종류별 프리뷰: 그림/표=썸네일(+라이트박스), 수식=KaTeX, 정리/명제=본문(인라인 수식 렌더).
import { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import katex from "katex";
import { CrossRefContext } from "./crossrefs";
import { Formula } from "./Formula";
import { jumpToElement } from "../nav/jump";

const HOVER_MS = 900; // 호버 후 프리뷰 뜨기까지(~1초)
const POP_MAXH = 340;
type Timer = ReturnType<typeof setTimeout>;

// 프리뷰용 인라인 수식 렌더($...$). 참조/각주 재귀 없이 텍스트+KaTeX 만.
function previewNodes(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /(?<!\\)\$(.+?)(?<!\\)\$/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    try {
      const html = katex.renderToString(m[1], { displayMode: false, throwOnError: true, strict: false });
      parts.push(<span key={i++} dangerouslySetInnerHTML={{ __html: html }} />);
    } catch {
      parts.push(m[0]);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function RefLink({ targetKey, label }: { targetKey: string; label: string }) {
  const { index, docId } = useContext(CrossRefContext);
  const target = index.get(targetKey);
  const [open, setOpen] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const ref = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<Timer | null>(null);
  const closeTimer = useRef<Timer | null>(null);

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  useEffect(() => () => clearTimers(), []);

  // 프리뷰 열렸을 때 Esc / 바깥 클릭 닫기
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (lightbox ? setLightbox(false) : setOpen(false));
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, lightbox]);

  if (!target) return <>{label}</>;

  const { block, kind } = target;
  const imgUrl = block.image ? window.paperAPI.assetUrl(docId, block.image) : null;

  const scheduleOpen = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (open) return;
    openTimer.current = setTimeout(() => {
      const r = ref.current?.getBoundingClientRect();
      if (r) {
        let top = r.bottom + 6;
        if (top + POP_MAXH > window.innerHeight - 8) top = Math.max(8, r.top - POP_MAXH - 6);
        setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 372)), top });
      }
      setOpen(true);
    }, HOVER_MS);
  };
  const scheduleClose = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 220);
  };

  const jump = (e: React.MouseEvent) => {
    e.stopPropagation();
    clearTimers();
    setOpen(false);
    const el = document.querySelector(`[data-block-id="${block.id}"]`) as HTMLElement | null;
    if (!el) return;
    jumpToElement(el); // 원래 위치 기록 + 가운데 정렬
    el.classList.add("ref-target-flash");
    setTimeout(() => el.classList.remove("ref-target-flash"), 1400);
  };

  return (
    <>
      <span
        ref={ref}
        className={`refl refl-${kind} ${open ? "on" : ""}`}
        data-ref-target={block.id}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onClick={jump}
        role="button"
        title={`${target.label} — 클릭하면 이동`}
      >
        {label}
      </span>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="refl-pop"
            style={{ left: pos.left, top: pos.top }}
            onMouseEnter={() => closeTimer.current && clearTimeout(closeTimer.current)}
            onMouseLeave={scheduleClose}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="refl-pop-head">
              <span className="refl-pop-title">{target.label}</span>
              <button className="refl-pop-jump" onClick={jump}>이동 ↗</button>
            </div>
            <div className="refl-pop-body">
              {(kind === "figure" || kind === "table") && imgUrl && (
                <button className="figref-thumb" onClick={() => setLightbox(true)} title="크게 보기">
                  <img src={imgUrl} alt={target.label} />
                </button>
              )}
              {kind === "eq" ? (
                <div className="refl-eq"><Formula latex={block.latex ?? ""} display /></div>
              ) : (
                block.text && <p className="refl-text">{previewNodes(block.text)}</p>
              )}
            </div>
          </div>,
          document.body,
        )}
      {lightbox &&
        imgUrl &&
        createPortal(
          <div className="figref-lightbox" onClick={() => setLightbox(false)}>
            <figure onClick={(e) => e.stopPropagation()}>
              <img src={imgUrl} alt={target.label} />
              {block.text && <figcaption>{block.text}</figcaption>}
            </figure>
            <button className="figref-lightbox-x" onClick={() => setLightbox(false)} aria-label="닫기">✕</button>
          </div>,
          document.body,
        )}
    </>
  );
}
