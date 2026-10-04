// 본문 각주 참조 마커 — 클릭하면 각주 내용을 팝오버로 보여준다.
import { useEffect, useRef, useState, type ReactNode } from "react";
import DOMPurify from "dompurify";
import { createPortal } from "react-dom";
import type { Footnote } from "./footnotes";

const FN_HTML = { ALLOWED_TAGS: ["sup", "sub", "i", "b", "em", "strong", "br", "a"], ALLOWED_ATTR: ["href"] };

export function FootnoteRef({ note, sourceLabel, body }: { note: Footnote; sourceLabel?: string; body?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const ref = useRef<HTMLElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    const r = ref.current?.getBoundingClientRect();
    if (r) {
      setPos({
        left: Math.min(r.left, window.innerWidth - 380),
        top: Math.max(8, Math.min(r.bottom + 6, window.innerHeight - Math.min(window.innerHeight * .6, 420) - 16)),
      });
    }
    setOpen((v) => !v);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node) && e.target !== ref.current) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const clean = DOMPurify.sanitize(note.html, FN_HTML);

  return (
    <>
      <sup
        ref={ref as React.RefObject<HTMLElement>}
        className={`fn-ref ${open ? "on" : ""}`}
        data-fn-ref={note.label}
        onClick={toggle}
        role="button"
        tabIndex={0}
        aria-label={`${sourceLabel ?? "각주"} ${note.label} 보기`}
        aria-expanded={open}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ref.current?.click(); } }}
        title={sourceLabel ? `${sourceLabel} 보기` : "각주 보기"}
      >
        {note.label}
      </sup>
      {open && createPortal(
        <div
          ref={popRef}
          className="fn-pop"
          style={{ left: Math.max(8, pos.left), top: pos.top }}
          onMouseDown={(e) => e.stopPropagation()}
          role="dialog" aria-label={`${sourceLabel ?? "각주"} ${note.label}`}
        >
          <span className="fn-pop-label">{sourceLabel && `${sourceLabel} `}{note.label}</span>
          {body ? <span className="fn-pop-body">{body}</span> : <span className="fn-pop-body" dangerouslySetInnerHTML={{ __html: clean }} />}
        </div>
      , document.body)}
    </>
  );
}
