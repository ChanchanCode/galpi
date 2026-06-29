// 메모 레이어 — 선택한 문장에 코멘트를 남긴다(단축키 기본 M). 형광펜과 달리 "그 구절 하나"에 묶인다.
// 본문엔 점선 밑줄(::highlight(note-mark))로 표시하고, 작성/편집은 선택 위 팝오버에서 한다.
// 상태(notes)는 useAnnotations 훅이 소유하고 props 로 내려준다(제어형). 목록은 AnnotationsPanel 이 그린다.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PaperDocument } from "../types";
import { useStore } from "../store/useStore";
import { isEditableTarget, matchCombo } from "../keys/keymap";
import { normalizeText } from "../highlight/highlights";
import { clearNoteMarks, newNoteId, noteRanges, paintNoteMarks, type Note } from "./notes";

const CONTAINER_SEL = ".reader-content";

interface Props {
  doc: PaperDocument;
  notes: Note[];
  updateNotes: (updater: (prev: Note[]) => Note[]) => void;
}

// 편집 중인 팝오버 상태. id 가 있으면 기존 메모 편집, 없으면 새 메모.
interface Editing {
  id: string | null;
  quote: string;
  anchor: string;
  body: string;
  x: number;
  y: number;
}

export function NotesLayer({ doc, notes, updateNotes }: Props) {
  const noteCombo = useStore((s) => s.keymap.note);
  const [editing, setEditing] = useState<Editing | null>(null);
  // 호버 툴팁은 마우스가 아니라 메모가 적힌 텍스트(rect) 기준으로 위/아래에 띄운다.
  const [hover, setHover] = useState<{ note: Note; cx: number; ty: number; place: "above" | "below" } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 표식 Range 캐시 — 호버 시 커서가 어느 메모 위인지 판정에 재사용.
  const rangesRef = useRef<{ note: Note; range: Range }[]>([]);
  const hoverRaf = useRef<number | null>(null);

  // 문서 닫힐 때 표식 정리
  useEffect(() => () => clearNoteMarks(), [doc.doc_id]);

  // 메모/문서 변경 → 본문 표식 재계산 (DOM 렌더 후 rAF). Range 는 호버 판정용으로 캐시.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const container = document.querySelector(CONTAINER_SEL) as HTMLElement | null;
      if (!container) return;
      const pairs = noteRanges(container, notes);
      rangesRef.current = pairs;
      paintNoteMarks(pairs.map((p) => p.range));
    });
    return () => cancelAnimationFrame(raf);
  }, [notes, doc]);

  // 본문 위 호버 → 커서가 메모 구절 위면 그 메모를 툴팁으로. (CSS 하이라이트는 DOM 이 아니라
  // 직접 hit-test 불가 → caretRangeFromPoint 로 커서 위치를 얻어 표식 Range 안인지 검사.)
  useEffect(() => {
    const container = document.querySelector(CONTAINER_SEL) as HTMLElement | null;
    if (!container) return;
    const hitNote = (x: number, y: number): { note: Note; range: Range } | null => {
      const caret = (document as { caretRangeFromPoint?: (x: number, y: number) => Range | null })
        .caretRangeFromPoint?.(x, y);
      if (!caret) return null;
      for (const pair of rangesRef.current) {
        try {
          if (pair.range.isPointInRange(caret.startContainer, caret.startOffset)) return pair;
        } catch {
          /* 분리된 노드 등 — 무시 */
        }
      }
      return null;
    };
    const onMove = (e: MouseEvent) => {
      if (hoverRaf.current != null) return; // 프레임당 1회로 스로틀
      const x = e.clientX;
      const y = e.clientY;
      hoverRaf.current = requestAnimationFrame(() => {
        hoverRaf.current = null;
        if (!rangesRef.current.length) {
          setHover((h) => (h ? null : h));
          return;
        }
        const hit = hitNote(x, y);
        if (!hit) {
          setHover((h) => (h ? null : h));
          return;
        }
        // 같은 메모 위에서 움직이는 동안은 재배치 안 함(텍스트 고정 → 깜빡임/리렌더 방지).
        setHover((h) => {
          if (h && h.note.id === hit.note.id) return h;
          const rect = hit.range.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const above = rect.top > 120; // 위 공간 충분하면 위로, 아니면 아래로
          return { note: hit.note, cx, ty: above ? rect.top : rect.bottom, place: above ? "above" : "below" };
        });
      });
    };
    const onLeave = () => setHover((h) => (h ? null : h));
    container.addEventListener("mousemove", onMove);
    container.addEventListener("mouseleave", onLeave);
    return () => {
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", onLeave);
      if (hoverRaf.current != null) cancelAnimationFrame(hoverRaf.current);
    };
  }, [doc]);

  // 스크롤하면 표식 위치가 바뀌므로 툴팁 숨김
  useEffect(() => {
    if (!hover) return;
    const sc = document.querySelector(".reader-scroll");
    const hide = () => setHover(null);
    sc?.addEventListener("scroll", hide, { passive: true });
    return () => sc?.removeEventListener("scroll", hide);
  }, [hover]);

  // 현재 선택(본문 안) → 앵커/위치. 없으면 null.
  const readSelection = useCallback((): { quote: string; anchor: string; x: number; y: number } | null => {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return null;
    const quote = s.toString().trim();
    if (quote.length < 2) return null;
    const range = s.getRangeAt(0);
    const container = document.querySelector(CONTAINER_SEL);
    if (!container || !container.contains(range.commonAncestorContainer)) return null;
    const rect = range.getBoundingClientRect();
    return { quote, anchor: normalizeText(quote), x: rect.left + rect.width / 2, y: rect.bottom };
  }, []);

  // 단축키(기본 M): 선택 위에 메모 작성 팝오버. 이미 메모가 있는 구절이면 그 메모를 편집.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setEditing(null);
        return;
      }
      if (isEditableTarget(e.target)) return;
      if (e.repeat) return;
      if (!matchCombo(e, noteCombo)) return;
      const sel = readSelection();
      if (!sel) return;
      e.preventDefault();
      const existing = notes.find((n) => n.anchor === sel.anchor);
      setEditing(
        existing
          ? { id: existing.id, quote: existing.quote, anchor: existing.anchor, body: existing.body, x: sel.x, y: sel.y }
          : { id: null, quote: sel.quote, anchor: sel.anchor, body: "", x: sel.x, y: sel.y },
      );
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [noteCombo, readSelection, notes]);

  // 팝오버 열릴 때 textarea 포커스 + 커서 끝으로
  useEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, [editing?.id, editing !== null]);

  // 바깥 클릭 시 닫기(저장하지 않음 — 명시적 저장 버튼/⌘Enter 로만 저장)
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setEditing(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [editing]);

  const save = useCallback(() => {
    if (!editing) return;
    const body = editing.body.trim();
    const now = new Date().toISOString();
    if (editing.id) {
      // 편집: 비우면 삭제, 아니면 갱신
      updateNotes((prev) =>
        body
          ? prev.map((n) => (n.id === editing.id ? { ...n, body, updated_at: now } : n))
          : prev.filter((n) => n.id !== editing.id),
      );
    } else if (body) {
      const note: Note = {
        id: newNoteId(),
        quote: editing.quote,
        anchor: editing.anchor,
        body,
        created_at: now,
        updated_at: now,
      };
      updateNotes((prev) => [...prev, note]);
    }
    setEditing(null);
  }, [editing, updateNotes]);

  const del = useCallback(() => {
    if (!editing?.id) {
      setEditing(null);
      return;
    }
    const id = editing.id;
    updateNotes((prev) => prev.filter((n) => n.id !== id));
    setEditing(null);
  }, [editing, updateNotes]);

  // 호버 툴팁 — 편집 팝오버가 열려 있지 않을 때만, 메모 텍스트 위/아래에 띄움.
  const tooltip =
    !editing && hover ? (
      <div
        className={`note-tip ${hover.place}`}
        style={{
          left: Math.min(Math.max(hover.cx, 140), window.innerWidth - 140),
          top: hover.place === "above" ? hover.ty - 8 : hover.ty + 8,
        }}
      >
        {hover.note.body}
      </div>
    ) : null;

  if (!editing) return tooltip;

  // 화면 밖으로 안 나가게 가로 위치 보정(팝오버 폭 ~320)
  const left = Math.min(Math.max(editing.x, 170), window.innerWidth - 170);
  const top = Math.min(editing.y + 8, window.innerHeight - 220);

  return (
    <div className="note-pop-wrap" style={{ left, top }}>
      <div className="note-pop" ref={boxRef} onMouseDown={(e) => e.stopPropagation()}>
        <div className="note-quote">{editing.quote}</div>
        <textarea
          ref={taRef}
          className="note-input"
          placeholder="메모…"
          value={editing.body}
          onChange={(e) => setEditing((p) => (p ? { ...p, body: e.target.value } : p))}
          onKeyDown={(e) => {
            // Enter = 저장, ⇧Enter(또는 ⌘Enter) = 줄바꿈
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              save();
            }
          }}
        />
        <div className="note-pop-foot">
          {editing.id ? (
            <button className="note-del" onClick={del} title="메모 삭제">삭제</button>
          ) : (
            <span />
          )}
          <div className="note-pop-actions">
            <button className="note-cancel" onClick={() => setEditing(null)}>취소</button>
            <button className="note-save" onClick={save}>저장</button>
          </div>
        </div>
      </div>
    </div>
  );
}
