// 주석 인덱스 — 한 문서의 형광펜과 메모를 한 화면에 모아본다. 클릭하면 본문의 해당 위치로 점프.
// 상태는 useAnnotations 훅이 소유하고 props 로 받는다(제어형). 형광펜/메모 생성은 각 레이어가 담당.
import { useMemo, useState } from "react";
import { jumpWith } from "../nav/jump";
import {
  firstMatchRange,
  PALETTE,
  ruleScope,
  type HighlightRule,
  type HlColor,
  type HlStyle,
} from "../highlight/highlights";
import { firstNoteRange, type Note } from "../notes/notes";

const CONTAINER_SEL = ".reader-content";

interface Props {
  highlights: HighlightRule[];
  notes: Note[];
  counts: Record<string, number>;
  updateHighlights: (updater: (prev: HighlightRule[]) => HighlightRule[]) => void;
  updateNotes: (updater: (prev: Note[]) => Note[]) => void;
  onClose: () => void;
}

type Tab = "all" | "highlights" | "notes";

function jumpToRange(range: Range | null) {
  if (!range) return;
  const parentEl = range.startContainer.parentElement as HTMLElement | null;
  jumpWith(parentEl, () => {
    const rect = range.getBoundingClientRect();
    const scroller = document.querySelector(".reader-scroll") as HTMLElement | null;
    if (scroller) {
      scroller.scrollBy({ top: rect.top - scroller.clientHeight / 2, behavior: "smooth" });
    } else {
      parentEl?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });
}

export function AnnotationsPanel({
  highlights,
  notes,
  counts,
  updateHighlights,
  updateNotes,
  onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>("all");

  // ── 형광펜 조작 ──
  const setColor = (id: string, color: HlColor) =>
    updateHighlights((prev) => prev.map((r) => (r.id === id ? { ...r, color } : r)));
  const setStyle = (id: string, style: HlStyle) =>
    updateHighlights((prev) => prev.map((r) => (r.id === id ? { ...r, style } : r)));
  const setLabel = (id: string, label: string) =>
    updateHighlights((prev) => prev.map((r) => (r.id === id ? { ...r, label: label || null } : r)));
  const removeHl = (id: string) => updateHighlights((prev) => prev.filter((r) => r.id !== id));

  const jumpHl = (rule: HighlightRule) => {
    const container = document.querySelector(CONTAINER_SEL) as HTMLElement | null;
    if (container) jumpToRange(firstMatchRange(container, rule));
  };

  // ── 메모 조작 ──
  const setBody = (id: string, body: string) =>
    updateNotes((prev) =>
      prev.map((n) => (n.id === id ? { ...n, body, updated_at: new Date().toISOString() } : n)),
    );
  const removeNote = (id: string) => updateNotes((prev) => prev.filter((n) => n.id !== id));

  const jumpNote = (note: Note) => {
    const container = document.querySelector(CONTAINER_SEL) as HTMLElement | null;
    if (container) jumpToRange(firstNoteRange(container, note));
  };

  const sortedHl = useMemo(
    () => [...highlights].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [highlights],
  );
  const sortedNotes = useMemo(
    () => [...notes].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [notes],
  );

  const showHl = tab === "all" || tab === "highlights";
  const showNotes = tab === "all" || tab === "notes";
  const empty =
    (tab === "highlights" && highlights.length === 0) ||
    (tab === "notes" && notes.length === 0) ||
    (tab === "all" && highlights.length === 0 && notes.length === 0);

  return (
    <aside className="hl-panel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="hl-panel-head">
        <span>주석 모아보기</span>
        <button className="icon-btn" onClick={onClose} aria-label="닫기">✕</button>
      </div>

      <div className="ann-tabs">
        <button className={tab === "all" ? "on" : ""} onClick={() => setTab("all")}>
          전체 ({highlights.length + notes.length})
        </button>
        <button className={tab === "highlights" ? "on" : ""} onClick={() => setTab("highlights")}>
          형광펜 ({highlights.length})
        </button>
        <button className={tab === "notes" ? "on" : ""} onClick={() => setTab("notes")}>
          메모 ({notes.length})
        </button>
      </div>

      {empty ? (
        <p className="hl-empty">
          {tab === "notes" ? "메모 없음" : tab === "highlights" ? "형광펜 없음" : "형광펜·메모 없음"}
        </p>
      ) : (
        <ul className="hl-list">
          {showNotes &&
            sortedNotes.map((n) => (
              <li key={n.id} className="hl-row note-row">
                <div className="hl-row-top">
                  <button className="hl-jump" onClick={() => jumpNote(n)} title="메모 위치로 이동">
                    <span className="ann-badge note">메모</span>
                    <span className="hl-text">{n.quote}</span>
                  </button>
                  <button className="hl-del" onClick={() => removeNote(n.id)} title="삭제">🗑</button>
                </div>
                <textarea
                  className="note-body-edit"
                  defaultValue={n.body}
                  rows={2}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v !== n.body) v ? setBody(n.id, v) : removeNote(n.id);
                  }}
                />
              </li>
            ))}

          {showHl &&
            sortedHl.map((r) => (
              <li key={r.id} className="hl-row">
                <div className="hl-row-top">
                  <button
                    className="hl-jump"
                    onClick={() => jumpHl(r)}
                    title={ruleScope(r) === "keyword" ? "첫 출현으로 이동" : "칠한 위치로 이동"}
                  >
                    <span className={`ann-badge hl hl-${r.color}`}>
                      {ruleScope(r) === "keyword" ? "키워드" : "이 부분"}
                    </span>
                    <span className="hl-text">{r.text}</span>
                    {ruleScope(r) === "keyword" && <span className="hl-count">{counts[r.id] ?? 0}</span>}
                  </button>
                  <button className="hl-del" onClick={() => removeHl(r.id)} title="삭제">🗑</button>
                </div>
                <div className="hl-row-ctrls">
                  <div className="hl-colors">
                    {PALETTE.map((p) => (
                      <button
                        key={p.key}
                        className={`hl-swatch sm hl-${p.key} ${r.color === p.key ? "active" : ""}`}
                        title={p.label}
                        onClick={() => setColor(r.id, p.key)}
                      />
                    ))}
                  </div>
                  <button
                    className={`hl-style-btn ${r.style === "underline" ? "on" : ""}`}
                    onClick={() => setStyle(r.id, r.style === "fill" ? "underline" : "fill")}
                    title="채움 ↔ 밑줄"
                  >
                    {r.style === "fill" ? "채움" : "밑줄"}
                  </button>
                </div>
                <input
                  className="hl-label"
                  placeholder="라벨(선택)"
                  defaultValue={r.label ?? ""}
                  onBlur={(e) => setLabel(r.id, e.target.value.trim())}
                />
              </li>
            ))}
        </ul>
      )}
    </aside>
  );
}
