// 텍스트 검색 바 (Cmd+F) — 자체적으로 단축키를 듣고 열린다. text 위에 떠다니지 않고
// 우상단 고정 바로 표시(사용자 요청: 본문 hover UI 금지). Enter=다음 · ⇧Enter=이전 · Esc=닫기.
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { matchCombo } from "../keys/keymap";
import { clearSearch, findMatches, isHighlightSupported, paintSearch } from "./search";

const CONTAINER_SEL = ".reader-content";
const SCROLL_SEL = ".reader-scroll";

interface Props {
  // doc 이 바뀌면 검색 결과 재계산(스트리밍/문서 전환 대응)
  docId: string;
  blockCount: number;
}

export function FindBar({ docId, blockCount }: Props) {
  const keymap = useStore((s) => s.keymap);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [current, setCurrent] = useState(0);
  const [count, setCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);

  const scrollToCurrent = useCallback((ranges: Range[], idx: number) => {
    const r = ranges[idx];
    if (!r) return;
    const scroller = document.querySelector(SCROLL_SEL) as HTMLElement | null;
    const rect = r.getBoundingClientRect();
    if (scroller) {
      const sRect = scroller.getBoundingClientRect();
      const target = rect.top - sRect.top + scroller.scrollTop - scroller.clientHeight / 2;
      scroller.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    } else {
      (r.startContainer.parentElement as HTMLElement | null)?.scrollIntoView({ block: "center" });
    }
  }, []);

  // query / 대소문자 / 문서 변경 → 재검색. current 는 0 으로(가능하면 보존).
  const runSearch = useCallback(
    (q: string, cs: boolean, keepIdx: number) => {
      const container = document.querySelector(CONTAINER_SEL) as HTMLElement | null;
      if (!container) return;
      const ranges = findMatches(container, q, cs);
      rangesRef.current = ranges;
      setCount(ranges.length);
      const idx = ranges.length ? Math.min(keepIdx, ranges.length - 1) : 0;
      setCurrent(idx);
      paintSearch(ranges, idx);
      if (ranges.length) scrollToCurrent(ranges, idx);
    },
    [scrollToCurrent],
  );

  useEffect(() => {
    if (!open) return;
    runSearch(query, caseSensitive, current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, open, docId, blockCount]);

  const close = useCallback(() => {
    setOpen(false);
    clearSearch();
    rangesRef.current = [];
    setCount(0);
    setCurrent(0);
    window.getSelection()?.removeAllRanges();
  }, []);

  const step = useCallback(
    (dir: 1 | -1) => {
      const n = rangesRef.current.length;
      if (!n) return;
      setCurrent((prev) => {
        const next = (prev + dir + n) % n;
        paintSearch(rangesRef.current, next);
        scrollToCurrent(rangesRef.current, next);
        return next;
      });
    },
    [scrollToCurrent],
  );

  // 검색 단축키(또는 툴바 버튼 이벤트)로 열기/포커스.
  useEffect(() => {
    const openBar = () => {
      if (!isHighlightSupported()) return;
      setOpen(true);
      const selText = window.getSelection()?.toString().trim();
      if (selText && selText.length <= 80 && !query) setQuery(selText);
      requestAnimationFrame(() => inputRef.current?.select());
    };
    const onKey = (e: KeyboardEvent) => {
      if (matchCombo(e, keymap.search)) {
        e.preventDefault();
        openBar();
      }
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("galpi:find-open", openBar);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("galpi:find-open", openBar);
    };
  }, [keymap.search, query]);

  // 문서 닫힘/언마운트 시 정리
  useEffect(() => () => clearSearch(), []);

  if (!open) return null;

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="find-bar" role="search">
      <input
        ref={inputRef}
        className="find-input"
        placeholder="본문 검색"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onInputKey}
      />
      <span className="find-count">{count ? `${current + 1}/${count}` : query ? "없음" : ""}</span>
      <button
        className={`find-toggle ${caseSensitive ? "on" : ""}`}
        title="대소문자 구분"
        onClick={() => setCaseSensitive((v) => !v)}
      >
        Aa
      </button>
      <button className="find-nav" title="이전 (⇧Enter)" disabled={!count} onClick={() => step(-1)}>
        ↑
      </button>
      <button className="find-nav" title="다음 (Enter)" disabled={!count} onClick={() => step(1)}>
        ↓
      </button>
      <button className="find-close" title="닫기 (Esc)" onClick={close}>
        ✕
      </button>
    </div>
  );
}
