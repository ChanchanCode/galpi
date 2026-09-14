// 선택 미니 툴바 — 설명 · 형광펜 · 번역 · 메모 · 채팅에 인용 · "AI에게…" (SPEC §4.7).
// 예전 "본문 위 hover UI 금지" 규칙을 이 기능에 한해 사용자가 뒤집었다(설정 읽기 탭에서 끌 수 있다).
// 그래서 **마우스로 고른 선택**에만 뜨고, 키보드·스크롤·패닝이 시작되면 바로 사라진다 — 단축키 흐름(H/⇧H/M/T)을 가리지 않게.
//
// 이 컴포넌트는 툴바 말고도 두 가지를 늘 한다(툴바를 꺼도):
//  · 선택 잠금 — 누른 영역(원문/번역 컬럼/쪽 카드/지면 텍스트층) 밖으로 선택이 튀지 않게(드래그 중 CSS, 뗀 뒤 Range 자르기).
//    CSS 잠금은 다음 누름까지 유지한다 — 지면 선택은 쪽 사이 번역 카드를 가로지르는데, 풀면 그 카드가 선택색으로 칠해진다.
//  · 텍스트 끌기 — 선택을 끌면 application/x-galpi-quote 를 싣는다(채팅 입력창이 받는다).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store/useStore";
import { displayCombo, isEditableTarget } from "../keys/keymap";
import { emitChat } from "../chat/chatBus";
import {
  clampSelectionTo,
  elOf,
  emitAction,
  MIME_QUOTE,
  readSelectionQuote,
  regionOf,
  sameScope,
  SEL_REGION,
  type GalpiAction,
  type SelectionQuote,
} from "./quote";
import "./selection.css";

const ICO = {
  width: 17, height: 17, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const, "aria-hidden": true,
};
const COLORS: NonNullable<GalpiAction["color"]>[] = ["yellow", "green", "blue", "pink", "purple"];
const ASK_GROW = 132; // 입력창 포커스 시 늘어나는 폭(selection.css .seltb-ask 108 → 240)
const EXPLAIN = "이 부분을 설명해줘";
const POP_ROOM = 90; // 스와치 기둥(5×16 + 간격 ≈ 114px)이 툴바 밖으로 나오는 길이 — 창 가장자리까지 이만큼 비어야 그쪽으로 펼친다
// 이 클래스가 body 에 있으면 다른 드래그(캔버스 패닝·폭 조절·원본 크롭 이동)의 손 뗌이다.
const DRAG_BODY = ["src-panning", "tr-resizing", "peek-dragging", "rc-active"];

const KEEP_HL = "sel-keep"; // 입력창 포커스로 문서 선택이 사라져도 고른 구절을 보여 준다

function sameRange(a: Range, b: Range): boolean {
  try {
    return a.compareBoundaryPoints(Range.START_TO_START, b) === 0 && a.compareBoundaryPoints(Range.END_TO_END, b) === 0;
  } catch {
    return false;
  }
}

function paintKeep(range: Range | null): void {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return;
  CSS.highlights.delete(KEEP_HL);
  if (range) CSS.highlights.set(KEEP_HL, new Highlight(range));
}

export function SelectionToolbar({ docId }: { docId: string; docTitle?: string }) {
  const enabled = useStore((s) => s.reading.selToolbar) !== false;
  const keymap = useStore((s) => s.keymap);
  const [tb, setTb] = useState<SelectionQuote | null>(null);
  const [ask, setAsk] = useState("");
  const [swOpen, setSwOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 문서 수준 리스너는 한 번만 붙인다 — 최신 값은 ref 로 본다.
  const tbRef = useRef<SelectionQuote | null>(null);
  tbRef.current = tb;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const press = useRef<{ region: HTMLElement | null; x: number; y: number; moved: boolean } | null>(null);
  const lockRoot = useRef<HTMLElement | null>(null);
  const upTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    if (!tbRef.current) return;
    tbRef.current = null;
    setTb(null);
    setAsk("");
    setSwOpen(false);
    paintKeep(null);
  }, []);

  const unlock = useCallback(() => {
    if (!lockRoot.current) return; // 클래스 조작만으로도 스타일 무효화가 난다 — 잠근 적 없으면 건드리지 않는다
    lockRoot.current.classList.remove("sel-root");
    lockRoot.current = null;
    document.body.classList.remove("sel-lock", "sel-lock-page");
  }, []);

  // ── 선택 잠금 · 표시 · 숨김 ────────────────────────────────────
  useEffect(() => {
    const inBox = (t: EventTarget | null) => !!boxRef.current && t instanceof Node && boxRef.current.contains(t);

    const onDown = (e: PointerEvent) => {
      if (inBox(e.target)) return;
      hide();
      unlock();
      press.current = null;
      if (e.button !== 0 || e.altKey) return; // ⌥+드래그는 영역 캡처
      const t = e.target instanceof Element ? e.target : null;
      if (!t || t.closest(".chat-panel") || isEditableTarget(t)) return;
      press.current = { region: regionOf(t), x: e.clientX, y: e.clientY, moved: false };
    };

    // 실제로 끌기 시작했을 때만 잠근다 — 클릭마다 스타일 재계산을 일으키지 않게.
    // 번역 카드에서 끌다 원문으로 넘어가도 한국어+영어가 한 선택에 섞이지 않는다.
    const onMove = (e: PointerEvent) => {
      const p = press.current;
      if (!p || p.moved || !p.region || !(e.buttons & 1)) return;
      if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) < 4) return;
      p.moved = true;
      if (document.querySelectorAll(SEL_REGION).length < 2) return; // 튈 곳이 없다(리플로우 단독)
      lockRoot.current = p.region;
      p.region.classList.add("sel-root");
      document.body.classList.add("sel-lock");
      // 지면 텍스트층은 쪽을 넘어 이어 고른다 — 다른 쪽 층은 열어 둔다(selection.css).
      if (p.region.matches(".src-textlayer")) document.body.classList.add("sel-lock-page");
    };

    const onUp = (e: PointerEvent) => {
      const p = press.current;
      press.current = null;
      if (!p || e.button !== 0) return;
      // 패닝 등의 up 리스너가 body 표식을 지우기 **전**에 판정한다(창 capture 가 먼저 돈다).
      const otherDrag = DRAG_BODY.some((c) => document.body.classList.contains(c));
      if (upTimer.current) clearTimeout(upTimer.current);
      // 선택은 mouseup 기본 동작까지 끝나야 확정된다(클릭이면 여기서 접힌다) → 한 틱 뒤에 본다.
      upTimer.current = setTimeout(() => {
        upTimer.current = null;
        if (p.region) clampSelectionTo(p.region);
        // 영역 안에서 누른 선택만 — 버튼 클릭은 선택을 지우지 않으므로 아무 up 에나 띄우면 툴바가 되살아난다.
        if (otherDrag || !enabledRef.current || !p.region) return;
        if (document.activeElement && isEditableTarget(document.activeElement)) return;
        const sq = readSelectionQuote(2);
        if (!sq || !sameScope(sq.region, p.region)) return;
        tbRef.current = sq;
        setTb(sq);
        setAsk("");
        setSwOpen(false);
      }, 0);
    };

    // 누름이 끝나지 않고 끊김(선택 끌기 시작·창 전환) — 누름만 잊는다. 잠금은 선택이 사라질 때 풀린다.
    const onCancel = () => {
      press.current = null;
    };

    const onKey = (e: KeyboardEvent) => {
      if (!tbRef.current || inBox(e.target)) return;
      if (e.key === "Shift" || e.key === "Meta" || e.key === "Control" || e.key === "Alt" || e.key === "CapsLock") return;
      hide();
    };

    const onScrollish = (e: Event) => {
      if (!tbRef.current || inBox(e.target)) return;
      if (e.target instanceof Element && e.target.closest(".chat-panel")) return; // 채팅 스크롤은 본문 위치와 무관
      hide();
    };

    const onSelChange = () => {
      // 선택이 사라졌으면 잠금도 푼다(누르는 중엔 아님 — 드래그 시작 순간의 접힘이 늦게 도착한다).
      if (lockRoot.current && !press.current && window.getSelection()?.isCollapsed !== false) unlock();
      const cur = tbRef.current;
      if (!cur || document.activeElement === inputRef.current) return; // 입력창 포커스는 원래 선택을 지운다
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount || !sameRange(sel.getRangeAt(0), cur.range)) hide();
    };

    // 선택을 끌면 인용을 싣는다. 그림 <img> 끌기는 FigureMenu 가 맡는다.
    const onDragStart = (e: DragEvent) => {
      const dt = e.dataTransfer;
      const el = elOf(e.target as Node | null);
      if (!dt || !el || el.closest("img")) return;
      hide();
      const sq = readSelectionQuote(1);
      if (!sq || !sameScope(regionOf(el), sq.region)) return; // 선택 밖(링크 등)에서 시작한 끌기는 건드리지 않는다
      dt.setData(MIME_QUOTE, JSON.stringify(sq.quote));
      if (!dt.types.includes("text/plain")) dt.setData("text/plain", sq.quote.text);
    };

    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("blur", onCancel);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScrollish, { capture: true, passive: true });
    window.addEventListener("wheel", onScrollish, { capture: true, passive: true });
    window.addEventListener("resize", hide);
    window.addEventListener("galpi:capture-start", hide);
    document.addEventListener("selectionchange", onSelChange);
    window.addEventListener("dragstart", onDragStart, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onScrollish, true);
      window.removeEventListener("wheel", onScrollish, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("galpi:capture-start", hide);
      document.removeEventListener("selectionchange", onSelChange);
      window.removeEventListener("dragstart", onDragStart, true);
      if (upTimer.current) clearTimeout(upTimer.current);
      upTimer.current = null;
      unlock();
      paintKeep(null);
    };
  }, [hide, unlock]);

  // 문서가 바뀌거나 설정에서 끄면 닫는다.
  useEffect(() => hide(), [docId, hide]);
  useEffect(() => {
    if (!enabled) hide();
  }, [enabled, hide]);

  // 위치: 선택 첫 줄 위(공간 없으면 마지막 줄 아래), 가로는 선택 중심. 입력창이 넓어져도 잘리지 않게 최대 폭으로 자른다.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!tb || !el) return;
    const rects = Array.from(tb.range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    const bound = tb.range.getBoundingClientRect();
    const first = rects[0] ?? bound;
    const last = rects[rects.length - 1] ?? bound;
    const scroll = document.querySelector(".reader-scroll")?.getBoundingClientRect();
    const minTop = Math.max(8, (scroll?.top ?? 0) + 6);
    const maxBottom = window.innerHeight - 8;
    const h = el.offsetHeight;
    const wMax = el.offsetWidth + ASK_GROW;
    let place: "above" | "below" = "above";
    let top = first.top - h - 8;
    if (top < minTop) {
      place = "below";
      top = last.bottom + 8;
      if (top + h > maxBottom) top = Math.max(minTop, maxBottom - h);
    }
    const cx = Math.min(Math.max(bound.left + bound.width / 2, wMax / 2 + 8), window.innerWidth - wMax / 2 - 8);
    el.style.left = `${Math.round(cx)}px`;
    el.style.top = `${Math.round(top)}px`;
    // 툴팁·스와치 기둥은 선택 반대쪽으로 펼친다. 그쪽 창 공간이 모자라면 뒤집는다(창 밖으로 잘리지 않게).
    const pop = place === "above" ? (top >= POP_ROOM ? "up" : "down") : top + h + POP_ROOM <= window.innerHeight ? "down" : "up";
    el.dataset.pop = pop;
  }, [tb]);

  if (!tb) return null;
  const origin = tb.quote.origin;
  const isSource = origin === "source"; // 형광펜·메모는 리플로우 원문에만 앵커가 있다
  const canTranslate = origin !== "translation";

  // 입력창에 포커스가 가 있었으면 문서 선택이 사라졌다 — 기능 호출 전에 되돌린다.
  const restore = () => {
    inputRef.current?.blur();
    const sel = window.getSelection();
    if (!sel) return;
    if (sel.rangeCount && sameRange(sel.getRangeAt(0), tb.range)) return;
    sel.removeAllRanges();
    sel.addRange(tb.range.cloneRange());
  };
  const act = (a: GalpiAction) => {
    restore();
    paintKeep(null);
    emitAction(a);
    // 형광펜은 툴바를 남긴다 — 이어서 색을 바꿀 수 있게(선택도 레이어가 유지한다).
    if (a.id !== "highlightPassage") hide();
  };
  const send = (text: string) => {
    emitChat({ type: "ask", text, quotes: [tb.quote] });
    window.getSelection()?.removeAllRanges();
    hide();
  };
  const noFocus = (e: React.MouseEvent) => e.preventDefault(); // 버튼이 선택을 지우지 않게

  return createPortal(
    <div
      ref={boxRef}
      className="seltb"
      role="toolbar"
      onMouseDown={(e) => {
        if (e.target !== inputRef.current) e.preventDefault();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button className="seltb-btn" data-tip="설명" aria-label="설명" onMouseDown={noFocus} onClick={() => send(EXPLAIN)}>
        <svg {...ICO}>
          <circle cx="10.5" cy="11.5" r="5.8" />
          <path d="M14.8 15.8L19.5 20.5" />
          <path d="M18.6 2.8l.55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45-1.45-.55 1.45-.55z" />
        </svg>
      </button>
      {isSource && (
        <div className={`seltb-hl ${swOpen ? "open" : ""}`} onMouseLeave={() => setSwOpen(false)}>
          <button
            className="seltb-btn"
            data-tip={`형광펜 · ${displayCombo(keymap.highlightPassage)}`}
            aria-label="형광펜"
            onMouseDown={noFocus}
            onClick={() => act({ id: "highlightPassage" })}
          >
            <svg {...ICO}>
              <path d="M15.2 4.3l4.5 4.5-8.9 8.9H6.3v-4.5z" />
              <path d="M12.4 7.1l4.5 4.5" />
              <path d="M4 20.5h9" />
            </svg>
          </button>
          <span className="seltb-strip" aria-hidden onMouseEnter={() => setSwOpen(true)}>
            {COLORS.map((c) => <i key={c} className={`hl-${c}`} />)}
          </span>
          {swOpen && (
            <span className="seltb-col">
              {COLORS.map((c) => (
                <button
                  key={c}
                  className={`hl-swatch sm hl-${c}`}
                  aria-label={c}
                  onMouseDown={noFocus}
                  onClick={() => act({ id: "highlightPassage", color: c })}
                />
              ))}
            </span>
          )}
        </div>
      )}
      {canTranslate && (
        <button
          className="seltb-btn"
          data-tip={`번역 · ${displayCombo(keymap.translate)}`}
          aria-label="번역"
          onMouseDown={noFocus}
          onClick={() => act({ id: "translate" })}
        >
          <svg {...ICO}>
            <circle cx="12" cy="12" r="8.5" />
            <path d="M3.5 12h17" />
            <path d="M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z" />
          </svg>
        </button>
      )}
      {isSource && (
        <button
          className="seltb-btn"
          data-tip={`메모 · ${displayCombo(keymap.note)}`}
          aria-label="메모"
          onMouseDown={noFocus}
          onClick={() => act({ id: "note" })}
        >
          <svg {...ICO}>
            <path d="M5.5 4.5h13a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H11l-4.5 3.5v-3.5h-1a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z" />
          </svg>
        </button>
      )}
      <button
        className="seltb-btn"
        data-tip="채팅에 인용"
        aria-label="채팅에 인용"
        onMouseDown={noFocus}
        onClick={() => {
          emitChat({ type: "quote", quote: tb.quote });
          hide();
        }}
      >
        <svg {...ICO}>
          <path d="M17 6H3.5" />
          <path d="M20.5 12H8.5" />
          <path d="M20.5 18H8.5" />
          <path d="M3.5 12v6" />
        </svg>
      </button>
      <input
        ref={inputRef}
        className="seltb-ask"
        placeholder="AI에게…"
        value={ask}
        spellCheck={false}
        onChange={(e) => setAsk(e.target.value)}
        onFocus={() => paintKeep(tb.range)}
        onBlur={() => paintKeep(null)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return; // 한글 조합 중 Enter 는 조합 확정
          if (e.key === "Enter") {
            e.preventDefault();
            const v = ask.trim();
            if (v) send(v);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            restore();
            hide();
          }
        }}
      />
    </div>,
    document.body,
  );
}
