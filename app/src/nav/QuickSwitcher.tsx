// 퀵 스위처 (⌘P) — 라이브러리를 거치지 않고 문서 사이를 바로 전환.
// 최근 읽은 순 목록 + 타이핑 필터, ↑↓ 선택, Enter 열기, Esc 닫기.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocSummary } from "../../electron/preload";

interface Props {
  docs: DocSummary[];
  currentId: string | null;
  onOpen: (docId: string) => void;
  onClose: () => void;
}

export function QuickSwitcher({ docs, currentId, onOpen, onClose }: Props) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  // 라이브러리에서 바꾼 이름(library.json title 오버라이드)을 그대로 표시
  const [renames, setRenames] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    window.paperAPI
      .loadLibrary()
      .then((lib) => {
        const m: Record<string, string> = {};
        for (const [id, meta] of Object.entries(lib.docs ?? {})) if (meta.title) m[id] = meta.title;
        setRenames(m);
      })
      .catch(() => {});
  }, []);

  const displayTitle = (d: DocSummary) => renames[d.doc_id] ?? d.title ?? d.doc_id;

  const items = useMemo(() => {
    const sorted = [...docs]
      .filter((d) => d.doc_id !== currentId)
      .sort((a, b) => (b.last_read_at ?? "").localeCompare(a.last_read_at ?? ""));
    const needle = q.trim().toLowerCase();
    if (!needle) return sorted;
    return sorted.filter((d) =>
      `${renames[d.doc_id] ?? ""} ${d.title ?? ""} ${d.authors ?? ""} ${d.doc_id}`.toLowerCase().includes(needle),
    );
  }, [docs, currentId, q, renames]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => inputRef.current?.focus(), []);
  // 선택 항목이 보이도록 스크롤
  useEffect(() => {
    listRef.current?.children[idx]?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return onClose();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const d = items[idx];
      if (d) {
        onOpen(d.doc_id);
        onClose();
      }
    }
  };

  return (
    <div className="qs-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="qs-box" onKeyDown={onKey}>
        <input
          ref={inputRef}
          className="qs-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="문서 이름…"
          spellCheck={false}
        />
        <ul className="qs-list" ref={listRef}>
          {items.map((d, i) => (
            <li key={d.doc_id}>
              <button
                className={`qs-item ${i === idx ? "on" : ""}`}
                onMouseEnter={() => setIdx(i)}
                onClick={() => { onOpen(d.doc_id); onClose(); }}
              >
                <span className="qs-title">{displayTitle(d)}</span>
                {d.authors && <span className="qs-sub">{d.authors}</span>}
              </button>
            </li>
          ))}
          {!items.length && <li className="qs-none">없음</li>}
        </ul>
      </div>
    </div>
  );
}
