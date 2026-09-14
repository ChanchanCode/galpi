// 대화 기록 드롭다운 — 맨 위 새 대화, 아래로 세션(제목·상대시간). 행 hover 시 이름변경·삭제(두 번 눌러 확정).
import { useEffect, useRef, useState } from "react";
import type { ChatSessionMeta } from "../../electron/preload";
import { ICO } from "./MessageItem";

/** 방금 · 5분 · 3시간 · 2일 · 9/3 · 2025/9/3 */
export function relTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}일`;
  const d = new Date(t);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

interface Props {
  sessions: ChatSessionMeta[];
  currentId: string | null;
  busySessionId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement>;
}

export function SessionMenu({ sessions, currentId, busySessionId, onOpen, onNew, onRename, onDelete, onClose, anchorRef }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose, anchorRef]);

  const commit = () => {
    if (!editing) return;
    const { id, title } = editing;
    setEditing(null);
    if (title.trim() && title.trim() !== sessions.find((s) => s.id === id)?.title) onRename(id, title);
  };

  return (
    <div className="chat-pop chat-sessions trscroll-thin" ref={boxRef} onMouseLeave={() => setArmed(null)}>
      <button className="chat-sess-new" onClick={() => { onNew(); onClose(); }}>
        <svg {...ICO}><path d="M12 5v14M5 12h14" /></svg>
        <span>새 대화</span>
      </button>
      {sessions.length > 0 && <div className="ctx-sep" />}
      {sessions.map((s) => (
        <div key={s.id} className={`chat-sess ${s.id === currentId ? "on" : ""}`}>
          {editing?.id === s.id ? (
            <input
              className="chat-sess-input"
              autoFocus
              value={editing.title}
              maxLength={80}
              onChange={(e) => setEditing({ id: s.id, title: e.target.value })}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") commit();
                else if (e.key === "Escape") {
                  e.stopPropagation();
                  setEditing(null);
                }
              }}
              onBlur={commit}
            />
          ) : (
            <button
              className="chat-sess-main"
              onClick={() => {
                onOpen(s.id);
                onClose();
              }}
              title={s.title}
            >
              <span className="chat-sess-title">{s.title || "새 대화"}</span>
              <span className="chat-sess-time">{relTime(s.updatedAt)}</span>
            </button>
          )}
          {editing?.id !== s.id && (
            <span className="chat-sess-acts">
              <button className="chat-ico" onClick={() => setEditing({ id: s.id, title: s.title })} title="이름 변경" aria-label="이름 변경">
                <svg {...ICO}><path d="M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></svg>
              </button>
              <button
                className={`chat-ico ${armed === s.id ? "danger" : ""}`}
                disabled={busySessionId === s.id}
                onClick={() => {
                  if (armed !== s.id) return setArmed(s.id);
                  setArmed(null);
                  onDelete(s.id);
                }}
                title={armed === s.id ? "한 번 더 누르면 삭제" : "삭제"}
                aria-label="삭제"
              >
                <svg {...ICO}><path d="M4.5 7h15" /><path d="M9.5 7V4.5h5V7" /><path d="M6.5 7l1 12.5h9l1-12.5" /></svg>
              </button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
