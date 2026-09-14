// 답변 모델 드롭다운 — 짧은 라벨, agy / API 두 묶음. 입력창 하단이라 위로 연다.
import { useEffect, useRef, useState } from "react";
import type { ChatModelInfo } from "../../electron/preload";
import { modelLabel } from "./MessageItem";

interface Props {
  models: ChatModelInfo[];
  value: string;
  onChange: (id: string) => void;
}

const GROUPS: { key: "agy" | "api"; label: string }[] = [
  { key: "agy", label: "Antigravity" },
  { key: "api", label: "API" },
];

export function ModelPicker({ models, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    // 선택된 항목이 보이게
    boxRef.current?.querySelector<HTMLElement>(".on")?.scrollIntoView({ block: "nearest" });
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const label = modelLabel(value, models);
  const known = models.some((m) => m.id === value);

  return (
    <span className="chat-model">
      <button
        ref={btnRef}
        className={`chat-pill ${open ? "on" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={value}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="chat-pill-text">{label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 15l6-6 6 6" />
        </svg>
      </button>
      {open && (
        <div className="chat-pop chat-model-pop" ref={boxRef} role="listbox">
          {!known && value && (
            <button className="chat-pop-item on" role="option" aria-selected onClick={() => setOpen(false)}>
              {label}
            </button>
          )}
          {GROUPS.map((g) => {
            const items = models.filter((m) => (g.key === "agy" ? m.group === "agy" : m.group !== "agy"));
            if (!items.length) return null;
            return (
              <div key={g.key} className="chat-pop-group">
                <div className="chat-pop-label">{g.label}</div>
                {items.map((m) => (
                  <button
                    key={m.id}
                    role="option"
                    aria-selected={m.id === value}
                    className={`chat-pop-item ${m.id === value ? "on" : ""}`}
                    title={m.id}
                    onClick={() => {
                      setOpen(false);
                      if (m.id !== value) onChange(m.id);
                    }}
                  >
                    {m.label}
                    {g.key === "api" && <span className="chat-pop-sub">{m.group}</span>}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}
