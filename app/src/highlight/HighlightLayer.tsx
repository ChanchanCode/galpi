// 키워드 형광펜 (명세 §8) — 단축키 전용. (사용자 요청: 선택 시 뜨던 미니 툴바 제거,
// text 위 hover UI 금지.) 본문에서 텍스트 선택 후:
//   · 단축키 탭 → 색 순환(노랑→초록→파랑→분홍→보라→해제)
//   · 단축키 꾹 누름 → 즉시 제거
// 같은 텍스트가 문서 전체에서 함께 칠해진다. 규칙은 문서별 state.json 에 영속(§10).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PaperDocument } from "../types";
import { useStore } from "../store/useStore";
import { baseKey, isEditableTarget, matchCombo } from "../keys/keymap";
import { jumpWith } from "../nav/jump";
import {
  applyHighlights,
  clearHighlights,
  firstMatchRange,
  isHighlightSupported,
  normalizeText,
  PALETTE,
  type HighlightRule,
  type HlColor,
  type HlStyle,
} from "./highlights";

const CONTAINER_SEL = ".reader-content";
const HOLD_MS = 450; // 이 시간 이상 누르면 "제거"
const CYCLE: HlColor[] = ["yellow", "green", "blue", "pink", "purple"];
const COLOR_LABEL: Record<HlColor, string> = {
  yellow: "노랑",
  green: "초록",
  blue: "파랑",
  pink: "분홍",
  purple: "보라",
};

interface Props {
  doc: PaperDocument;
  panelOpen: boolean;
  onClosePanel: () => void;
}

function newId(): string {
  return "h_" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

export function HighlightLayer({ doc, panelOpen, onClosePanel }: Props) {
  const keymap = useStore((s) => s.keymap);
  const [rules, setRules] = useState<HighlightRule[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedFor = useRef<string | null>(null);
  // 누름 추적: 같은 키 keydown→keyup 구간으로 탭/홀드 판별
  const press = useRef<{ key: string; text: string; held: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);

  // 문서 열릴 때 규칙 로드 (state.json 사이드카)
  useEffect(() => {
    let alive = true;
    loadedFor.current = null;
    (async () => {
      const st = (await window.paperAPI.loadState(doc.doc_id)) as
        | { highlights?: HighlightRule[] }
        | null;
      if (!alive) return;
      setRules(Array.isArray(st?.highlights) ? st!.highlights! : []);
      loadedFor.current = doc.doc_id;
    })();
    return () => {
      alive = false;
      clearHighlights();
    };
  }, [doc.doc_id]);

  // 규칙 변경 → 디바운스 영속(병합 저장, 다른 state 키 보존)
  const persist = useCallback(
    (next: HighlightRule[]) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const docId = doc.doc_id;
      saveTimer.current = setTimeout(() => {
        if (loadedFor.current === docId) {
          void window.paperAPI.updateReading(docId, { highlights: next });
        }
      }, 300);
    },
    [doc.doc_id],
  );

  const updateRules = useCallback(
    (updater: (prev: HighlightRule[]) => HighlightRule[]) => {
      setRules((prev) => {
        const next = updater(prev);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  // 규칙/문서 변경 → 하이라이트 재계산 (DOM 렌더 후 rAF).
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const container = document.querySelector(CONTAINER_SEL) as HTMLElement | null;
      if (container) setCounts(applyHighlights(container, rules));
    });
    return () => cancelAnimationFrame(raf);
  }, [rules, doc]);

  const flashStatus = useCallback((msg: string) => {
    setStatus(msg);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), 1400);
  }, []);

  // 선택 배경 살짝 숨김 — ::selection 파란 배경이 형광펜 색 위에 그려져 색을 가리므로,
  // 형광펜을 적용한 직후에만 투명하게(선택 자체는 유지). 다음 드래그/클릭 때 복원.
  const dimmedFor = useRef<string | null>(null);
  const setDim = useCallback((text: string | null) => {
    if (text) {
      document.body.dataset.hlDim = "on";
      dimmedFor.current = text;
    } else {
      delete document.body.dataset.hlDim;
      dimmedFor.current = null;
    }
  }, []);

  // 새 선택을 시작하거나(드래그/클릭) 선택이 바뀌면 dim 해제 → 일반 선택 표시 복원.
  useEffect(() => {
    const onSelChange = () => {
      if (!dimmedFor.current) return;
      const t = normalizeText(window.getSelection()?.toString() ?? "");
      if (t !== dimmedFor.current) setDim(null);
    };
    const onDown = () => {
      if (dimmedFor.current) setDim(null);
    };
    document.addEventListener("selectionchange", onSelChange);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("selectionchange", onSelChange);
      document.removeEventListener("mousedown", onDown);
      setDim(null);
    };
  }, [setDim]);

  // 현재 선택의 정규화 텍스트(본문 컨테이너 안이어야 함)
  const readSelectionText = useCallback((): string | null => {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return null;
    const text = normalizeText(s.toString());
    if (text.length < 2) return null;
    const range = s.getRangeAt(0);
    const container = document.querySelector(CONTAINER_SEL);
    if (!container || !container.contains(range.commonAncestorContainer)) return null;
    return text;
  }, []);

  // 같은 텍스트(대소문자 무시) 규칙 — 중복 생성 방지(§8.4)
  const findRuleByText = useCallback(
    (prev: HighlightRule[], text: string) => prev.find((r) => r.text === text && !r.case_sensitive),
    [],
  );

  // 탭: 색 순환(없으면 노랑 → … → 보라 → 해제)
  const cycle = useCallback(
    (text: string) => {
      updateRules((prev) => {
        const existing = findRuleByText(prev, text);
        if (!existing) {
          const rule: HighlightRule = {
            id: newId(),
            text,
            color: "yellow",
            style: "fill",
            case_sensitive: false,
            whole_word: true,
            label: null,
            note: null,
            created_at: new Date().toISOString(),
          };
          flashStatus(`${COLOR_LABEL.yellow} 형광펜`);
          setDim(text); // 색이 보이도록 선택 배경 숨김
          return [...prev, rule];
        }
        const i = CYCLE.indexOf(existing.color);
        if (i >= CYCLE.length - 1) {
          flashStatus("형광펜 해제");
          setDim(null); // 칠한 게 없으니 선택 배경 복원
          return prev.filter((r) => r.id !== existing.id);
        }
        const next = CYCLE[i + 1];
        flashStatus(`${COLOR_LABEL[next]} 형광펜`);
        setDim(text);
        return prev.map((r) => (r.id === existing.id ? { ...r, color: next } : r));
      });
    },
    [updateRules, findRuleByText, flashStatus, setDim],
  );

  // 홀드: 즉시 제거
  const removeByText = useCallback(
    (text: string) => {
      updateRules((prev) => {
        const existing = findRuleByText(prev, text);
        if (!existing) return prev;
        flashStatus("형광펜 제거");
        setDim(null);
        return prev.filter((r) => r.id !== existing.id);
      });
    },
    [updateRules, findRuleByText, flashStatus, setDim],
  );

  // ── 키보드: 탭/홀드 판별 ─────────────────────────────────────────
  // keydown 에 바인딩이 정확히 일치하면 누름 시작, 같은 물리 키의 keyup 으로 종료.
  // (기본 H. 수식 조합으로 바꿔도 동작 — keyup 은 글자 키 release 로 판정.)
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.repeat) return;
      if (!matchCombo(e, keymap.highlight)) return;
      const text = readSelectionText();
      if (!text) return; // 선택 없으면 통과(다른 입력 방해 안 함)
      e.preventDefault();
      if (press.current) clearTimeout(press.current.timer);
      const timer = setTimeout(() => {
        if (press.current) {
          press.current.held = true;
          removeByText(press.current.text);
        }
      }, HOLD_MS);
      press.current = { key: baseKey(e) ?? "", text, held: false, timer };
    };
    const onUp = (e: KeyboardEvent) => {
      const p = press.current;
      if (!p || baseKey(e) !== p.key) return;
      clearTimeout(p.timer);
      if (!p.held) cycle(p.text); // 탭
      press.current = null;
      // 선택은 유지 → 연속 탭으로 색 순환 가능
    };
    document.addEventListener("keydown", onDown);
    document.addEventListener("keyup", onUp);
    return () => {
      document.removeEventListener("keydown", onDown);
      document.removeEventListener("keyup", onUp);
      if (press.current) clearTimeout(press.current.timer);
      press.current = null;
    };
  }, [keymap.highlight, readSelectionText, cycle, removeByText]);

  // ── 패널 동작 ────────────────────────────────────────────────────
  const setColor = (id: string, color: HlColor) =>
    updateRules((prev) => prev.map((r) => (r.id === id ? { ...r, color } : r)));
  const setStyle = (id: string, style: HlStyle) =>
    updateRules((prev) => prev.map((r) => (r.id === id ? { ...r, style } : r)));
  const setLabel = (id: string, label: string) =>
    updateRules((prev) => prev.map((r) => (r.id === id ? { ...r, label: label || null } : r)));
  const remove = (id: string) => updateRules((prev) => prev.filter((r) => r.id !== id));

  const jumpTo = (rule: HighlightRule) => {
    const container = document.querySelector(CONTAINER_SEL) as HTMLElement | null;
    if (!container) return;
    const range = firstMatchRange(container, rule);
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
  };

  const sortedRules = useMemo(
    () => [...rules].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [rules],
  );

  const unsupported = !isHighlightSupported();

  return (
    <>
      {status && <div className="hl-status">{status}</div>}

      {panelOpen && (
        <aside className="hl-panel" onMouseDown={(e) => e.stopPropagation()}>
          <div className="hl-panel-head">
            <span>형광펜 {rules.length > 0 && `(${rules.length})`}</span>
            <button className="icon-btn" onClick={onClosePanel} aria-label="닫기">✕</button>
          </div>
          {unsupported ? (
            <p className="hl-empty">이 환경은 하이라이트를 지원하지 않습니다.</p>
          ) : rules.length === 0 ? (
            <p className="hl-empty">
              본문에서 텍스트를 선택하고 형광펜 단축키를 탭하면 같은 단어가 전부 칠해집니다. 다시
              탭해 색을 바꾸고, 꾹 누르면 제거됩니다.
            </p>
          ) : (
            <ul className="hl-list">
              {sortedRules.map((r) => (
                <li key={r.id} className="hl-row">
                  <div className="hl-row-top">
                    <button className="hl-jump" onClick={() => jumpTo(r)} title="첫 출현으로 이동">
                      <span className="hl-text">{r.text}</span>
                      <span className="hl-count">{counts[r.id] ?? 0}</span>
                    </button>
                    <button className="hl-del" onClick={() => remove(r.id)} title="삭제">🗑</button>
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
                    placeholder="라벨/메모(선택)"
                    defaultValue={r.label ?? ""}
                    onBlur={(e) => setLabel(r.id, e.target.value.trim())}
                  />
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}
    </>
  );
}
