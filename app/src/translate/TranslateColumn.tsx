// 보기 A — 리플로우 ‖ 번역 (PLAN-AI §7.1, D8·D19·D20).
//
// 두 가지 제약이 이 파일의 구조를 정한다:
//  · D19 — 번역 컬럼은 `.reader-content` **밖**이다. 안에 넣으면 형광펜·메모·검색·내보내기 등
//    `.reader-content` 를 잡는 모듈 10곳이 한국어를 본문으로 먹는다.
//  · D20 — 행 정렬은 **JS 측정**이다. 그리드 래퍼를 끼우면 `:scope > [data-block-id]` 가정이
//    FocusMode·styles.css·focus-runtime 세 곳에서 깨진다.
// 그래서 카드는 절대 배치하고, 대응 블록의 화면 위치를 재서 top 을 직접 쓴다.
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { TrSource } from "./trBlocks";
import type { TrEntry } from "./useTranslation";
import { TR_WIDTH_MAX, TR_WIDTH_MIN } from "./useTranslation";
import { alignBlock, type Alignment } from "./align";
import { TrText } from "./TrText";
import { translatedText, translationFragments } from "./translationContent";

const GAP = 10; // 카드 사이 최소 간격(px)
const LINK_KEY = "tr-link"; // ::highlight(tr-link) 와 일치

interface Props {
  blocks: TrSource[];
  entries: Map<string, TrEntry>;
  width: number;
  onWidth: (n: number) => void;
  redoing: Set<string>;
  /** 재측정 트리거 — 타이포·읽기보조가 바뀌면 블록 높이가 달라진다. */
  relayoutKey: string;
}

function supported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

// 캔버스 `zoom` 이 걸리면 getBoundingClientRect() 는 화면px 을, style.top/offsetHeight 는
// 지역px 을 쓴다. 두 좌표계를 섞으면 배율만큼 어긋난다 — 무대 자신의 비로 환산한다.
function stageScale(stage: HTMLElement): number {
  const w = stage.offsetWidth;
  return w ? stage.getBoundingClientRect().width / w : 1;
}

function paintLink(range: Range | null): void {
  if (!supported()) return;
  CSS.highlights.delete(LINK_KEY);
  if (range) CSS.highlights.set(LINK_KEY, new Highlight(range));
}

export function TranslateColumn({ blocks, entries, width, onWidth, redoing, relayoutKey }: Props) {
  const colRef = useRef<HTMLElement>(null);
  const marksRef = useRef<HTMLDivElement>(null);
  // 블록별 좌표 정렬 캐시. 원문 문자열이 바뀌거나 DOM 이 갈리면 버린다.
  const alignCache = useRef(new Map<string, { el: HTMLElement; src: string; a: Alignment }>());
  const activeRef = useRef<HTMLElement | null>(null);

  const shown = blocks.filter((b) => translatedText(b, entries.get(b.id)));

  // ── 행 정렬 (D20) ──────────────────────────────────────────────
  // 번역이 원문보다 길면 **원문이 간격을 내준다**(사용자 확정).
  // 카드를 아래로 밀면 정렬이 어긋나고 결국 서로 겹친다 — 대신 원문 블록에
  // `padding-bottom` 을 넣어 그 행의 높이를 벌린다. 래퍼를 안 끼우므로
  // `:scope > [data-block-id]` 가정(D20)은 그대로다.
  //
  // 한 번에 끝내려면 자연 상태(주입한 padding 을 뺀 상태)를 알아야 한다. 예전에는 padding 을 **지우고** 다시 쟀는데,
  // 그러면 ① 전체 리플로우가 한 번 더 들고 ② 지운 순간 문서가 줄어 스크롤이 튀었다(사용자 신고 — 폭을 끌면 본문이 움직인다).
  // 이제는 지난번에 넣은 값을 기억해 두고 **측정값에서 빼서** 자연 상태를 계산한다. 쓰기는 바뀐 것만.
  // 읽기(블록 위치·카드 높이)를 전부 먼저 하고 쓰기를 나중에 몰아서 — 카드마다 읽고 쓰기를 섞으면 카드 수만큼 강제 리플로우다.
  const busy = useRef(false);
  const padOf = useRef(new WeakMap<HTMLElement, number>());
  const relayout = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    const col = colRef.current;
    const content = document.querySelector(".reader-content") as HTMLElement | null;
    const stage = content?.parentElement as HTMLElement | null;
    if (!col || !content || !stage) {
      busy.current = false;
      return;
    }
    const scroller = document.querySelector(".reader-scroll") as HTMLElement | null;

    const cards = Array.from(col.querySelectorAll<HTMLElement>(".tr-card"));
    // **렌더된 블록 전부**를 본다 — 카드가 붙는 블록만 보면 사이에 낀 표·수식·그림을
    // 카드가 타고 넘어 한국어가 표를 덮는다(실측). 이 블록들도 자리를 지켜야 한다.
    const all = Array.from(content.querySelectorAll<HTMLElement>(":scope > [data-block-id]"));
    const idxOf = new Map(all.map((el, i) => [el.dataset.blockId!, i]));

    // 0) 표시 여부만 먼저 맞춘다(바뀐 카드만 쓴다 — 읽기 전에 몰아서).
    const cardFor = new Map<number, HTMLElement>();
    for (const c of cards) {
      const i = idxOf.get(c.dataset.trFor!);
      const want = i == null ? "none" : "";
      if (c.style.display !== want) c.style.display = want;
      if (i != null) cardFor.set(i, c);
    }

    // 1) 읽기 — 블록 위치(현재 padding 포함) · 카드 높이 · 보던 자리.
    const k = stageScale(stage);
    const stageTop = stage.getBoundingClientRect().top;
    const rects = all.map((el) => el.getBoundingClientRect());
    const prev = all.map((el) => padOf.current.get(el) ?? (parseFloat(el.style.paddingBottom) || 0));
    const cardH = new Map<number, number>();
    for (const [i, c] of cardFor) cardH.set(i, c.offsetHeight);
    const sTop = scroller?.getBoundingClientRect().top ?? 0;
    let anchor = -1;
    for (let i = 0; i < all.length; i++) {
      if (rects[i].bottom > sTop + 1) {
        anchor = i;
        break;
      }
    }
    const anchorTop0 = anchor >= 0 ? rects[anchor].top : 0;

    // 2) 자연 상태 복원 — 앞 블록들에 넣었던 padding 누계를 빼고, 자기 padding 도 높이에서 뺀다.
    let cum = 0;
    const nat = all.map((_, i) => {
      const top = (rects[i].top - stageTop) / k - cum;
      const h = rects[i].height / k - prev[i];
      cum += prev[i];
      return { top, h };
    });
    const contentH = content.getBoundingClientRect().height / k - cum;

    // 3) 계산 — 블록 순서대로 누적 이동량을 쌓는다. 되먹임 반복이 없다.
    const topOf = new Map<string, number>();
    const pad: number[] = new Array(all.length).fill(0);
    const cardTop = new Map<number, number>();
    let shift = 0;
    for (let i = 0; i < all.length; i++) {
      const top = nat[i].top + shift;
      const h = cardH.get(i);
      if (h != null) {
        // **카드는 언제나 자기 블록 위쪽에 정확히 맞춘다.** 밀지 않는다.
        cardTop.set(i, top);
        topOf.set(all[i].dataset.blockId!, top);
        // 다음 블록까지의 자연 여백만큼은 공짜다 — 그만큼은 원문을 안 벌려도 된다.
        const free = i + 1 < all.length ? nat[i + 1].top - (nat[i].top + nat[i].h) : 0;
        const want = Math.max(0, Math.round(h + GAP - nat[i].h - free));
        // 배율이 바뀌면 화면px→지역px 환산에서 소수점이 흔들려 1px 씩 뒤집힌다. 그 1px 을 쓰면
        // 전체 레이아웃이 한 번 더 돈다(실측: 확대 확정 뒤 150ms 프레임이 하나 더) — 1px 이내면 지난 값 유지.
        pad[i] = Math.abs(want - prev[i]) <= 1 && padOf.current.has(all[i]) ? prev[i] : want;
      }
      shift += pad[i];
    }

    // 4) 쓰기 — 바뀐 것만.
    for (let i = 0; i < all.length; i++) {
      if (pad[i] === prev[i] && padOf.current.has(all[i])) continue;
      all[i].style.paddingBottom = pad[i] ? `${pad[i]}px` : "";
      padOf.current.set(all[i], pad[i]);
    }
    for (const [i, t] of cardTop) {
      const el = cardFor.get(i)!;
      if (Math.abs((parseFloat(el.style.top) || 0) - t) >= 0.5 || !el.style.top) el.style.top = `${Math.round(t * 2) / 2}px`;
    }
    const colH = contentH + shift;
    if (Math.abs((parseFloat(col.style.height) || 0) - colH) >= 1) col.style.height = `${Math.round(colH)}px`;

    // 페이지 마커 — 쪽이 바뀌는 첫 블록 위치에 얇은 선 하나. 위에서 구한 top 을 재사용한다.
    const marks = marksRef.current;
    if (marks) {
      for (const m of Array.from(marks.children) as HTMLElement[]) {
        const t = topOf.get(m.dataset.trMark!);
        if (t == null) {
          m.style.display = "none";
          continue;
        }
        m.style.display = "";
        m.style.top = `${t - 12}px`;
      }
    }

    // 5) 보던 자리 보정 — 화면 맨 위에 걸친 블록이 제자리에 있게 스크롤을 옮긴다.
    //    (위쪽 카드들이 짧아지면 여백이 사라지며 그만큼 본문이 올라온다. 여백은 사라지되 시선은 유지.)
    if (scroller && anchor >= 0) {
      const d = all[anchor].getBoundingClientRect().top - anchorTop0;
      if (Math.abs(d) >= 0.5) scroller.scrollTop += d;
    }

    // 우리가 쓴 padding 이 ResizeObserver 를 다시 때린다 — 그 프레임까지만 막는다.
    requestAnimationFrame(() => {
      busy.current = false;
    });
  }, []);

  useLayoutEffect(() => {
    relayout();
  }, [relayout, entries, width, relayoutKey, shown.length]);

  // 보던 자리 보정은 relayout 이 직접 한다 — 브라우저 스크롤 앵커링까지 겹치면 두 번 보정돼 본문이 크게 튄다(실측 +9천px).
  useEffect(() => {
    const scroller = document.querySelector(".reader-scroll") as HTMLElement | null;
    if (!scroller) return;
    const prev = scroller.style.overflowAnchor;
    scroller.style.overflowAnchor = "none";
    return () => {
      scroller.style.overflowAnchor = prev;
    };
  }, []);

  // 본문 높이가 바뀌는 모든 경로(타이포·폰트 로드·<details> 펼침·창 크기)를 한 번에 잡는다.
  useEffect(() => {
    const content = document.querySelector(".reader-content");
    if (!content) return;
    let raf = 0;
    const kick = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(relayout);
    };
    const ro = new ResizeObserver(kick);
    ro.observe(content);
    window.addEventListener("resize", kick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", kick);
    };
  }, [relayout]);

  // 원문이 바뀌면(재추출·페이지 병합 변화) 정렬 캐시를 버린다.
  useEffect(() => {
    alignCache.current.clear();
  }, [blocks, relayoutKey]);

  useEffect(
    () => () => {
      paintLink(null);
      // 번역을 끄면 원문에 넣은 여백도 함께 걷는다 — 안 그러면 리플로우 보기가 성기게 남는다.
      const content = document.querySelector(".reader-content");
      if (content) {
        for (const el of content.querySelectorAll<HTMLElement>("[data-block-id]")) el.style.paddingBottom = "";
      padOf.current = new WeakMap();
      }
    },
    [],
  );

  const alignFor = useCallback((id: string): Alignment | null => {
    const content = document.querySelector(".reader-content") as HTMLElement | null;
    const el = content?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
    const src = blocks.find((b) => b.id === id)?.text;
    if (!el || !src) return null;
    const hit = alignCache.current.get(id);
    if (hit && hit.el === el && hit.src === src) return hit.a;
    const a = alignBlock(el, src);
    alignCache.current.set(id, { el, src, a });
    return a;
  }, [blocks]);

  const setActive = useCallback((span: HTMLElement | null, range: Range | null) => {
    if (activeRef.current && activeRef.current !== span) activeRef.current.classList.remove("on");
    activeRef.current = span;
    if (span) span.classList.add("on");
    paintLink(range);
  }, []);

  // ── 번역 → 원문 ────────────────────────────────────────────────
  const onOver = useCallback(
    (e: React.MouseEvent) => {
      if (e.buttons & 1) return; // 드래그 선택 중엔 연결 표시를 바꾸지 않는다(선택 위에서 깜빡이지 않게)
      const span = (e.target as HTMLElement).closest<HTMLElement>(".tr-s");
      if (!span) return;
      const [id, idxRaw] = (span.dataset.g ?? "").split("#");
      const sp = entries.get(id)?.spans?.[Number(idxRaw)];
      if (!sp || sp.start < 0) return setActive(span, null);
      setActive(span, alignFor(id)?.rangeFor(sp.start, sp.end) ?? null);
    },
    [entries, alignFor, setActive],
  );

  // ── 원문 → 번역 ────────────────────────────────────────────────
  // 커서 아래 글자의 원문 오프셋을 구해 그 문장을 찾는다(§7.4 양방향).
  useEffect(() => {
    const content = document.querySelector(".reader-content") as HTMLElement | null;
    const col = colRef.current;
    if (!content || !col) return;
    let raf = 0;
    const onMove = (e: MouseEvent) => {
      if (raf || e.buttons & 1) return; // 드래그 선택 중엔 건너뛴다 — 프레임마다 caretRangeFromPoint 를 돌릴 이유가 없다

      const x = e.clientX;
      const y = e.clientY;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = (e.target as HTMLElement)?.closest?.("[data-block-id]") as HTMLElement | null;
        const id = el?.dataset.blockId;
        const spans = id ? entries.get(id)?.spans : undefined;
        if (!id || !spans?.length) return setActive(null, null);
        const caret = (document as { caretRangeFromPoint?: (x: number, y: number) => Range | null })
          .caretRangeFromPoint?.(x, y);
        if (!caret) return setActive(null, null);
        const a = alignFor(id);
        const off = a?.srcOffsetAt(caret.startContainer, caret.startOffset);
        if (off == null) return setActive(null, null);
        const idx = spans.findIndex((s) => s.start >= 0 && off >= s.start && off < s.end);
        if (idx < 0) return setActive(null, null);
        const span = col.querySelector<HTMLElement>(`[data-g="${CSS.escape(`${id}#${idx}`)}"]`);
        setActive(span, a!.rangeFor(spans[idx].start, spans[idx].end));
      });
    };
    const onLeave = () => setActive(null, null);
    content.addEventListener("mousemove", onMove);
    content.addEventListener("mouseleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      content.removeEventListener("mousemove", onMove);
      content.removeEventListener("mouseleave", onLeave);
    };
  }, [entries, alignFor, setActive]);

  // ── 폭 조절 (두 패널 사이 손잡이, §7.2) ─────────────────────────
  // 드래그 중에는 React 상태를 건드리지 않는다 — 프레임마다 App 전체와 카드 수백 개(KaTeX 포함)가
  // 다시 렌더돼 버벅였다(사용자 신고). 폭은 DOM 에 직접 쓰고 정렬은 rAF 로 프레임당 한 번, 놓을 때 상태에 한 번 반영.
  const widthRef = useRef(width);
  widthRef.current = width;
  const onGrip = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const col = colRef.current;
      const stage = (document.querySelector(".reader-content") as HTMLElement | null)?.parentElement as HTMLElement | null;
      const doc = stage?.parentElement as HTMLElement | null; // .src-doc — zoom 이 걸린 폭 래퍼
      const canvas = stage?.closest(".rd-canvas") as HTMLElement | null;
      if (!col || !stage) return;
      const x0 = e.clientX;
      const w0 = widthRef.current;
      const k = stageScale(stage);
      const stage0 = parseFloat(stage.style.width) || stage.offsetWidth;
      const baseW = canvas ? canvas.clientWidth : 0;
      let w = w0;
      let raf = 0;
      const apply = () => {
        raf = 0;
        col.style.width = `${w}px`;
        const sw = stage0 + (w - w0);
        stage.style.width = `${sw}px`;
        stage.style.setProperty("--tr-col-w", `${w}px`);
        if (doc) doc.style.width = `${Math.max(baseW, sw)}px`; // App 과 같은 식(Math.max(baseW, stageW))
        relayout();
      };
      // 손잡이가 번역탭 오른쪽 끝에 있으므로 오른쪽으로 끌면 넓어진다(사용자 확정).
      const move = (ev: PointerEvent) => {
        w = Math.max(TR_WIDTH_MIN, Math.min(TR_WIDTH_MAX, Math.round(w0 + (ev.clientX - x0) / Math.max(k, 0.01))));
        if (!raf) raf = requestAnimationFrame(apply);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.classList.remove("tr-resizing");
        if (raf) {
          cancelAnimationFrame(raf);
          apply();
        }
        if (w !== w0) onWidth(w);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      document.body.classList.add("tr-resizing");
    },
    [onWidth, relayout],
  );

  // 쪽이 바뀌는 첫 블록만 마커를 받는다.
  const marks: { id: string; page: number }[] = [];
  let lastPage = -1;
  for (const b of shown) {
    if (b.page !== lastPage) {
      marks.push({ id: b.id, page: b.page });
      lastPage = b.page;
    }
  }

  return (
    <>
      <aside
        ref={colRef}
        className="tr-col"
        style={{ width, minWidth: TR_WIDTH_MIN, maxWidth: TR_WIDTH_MAX }}
        onMouseOver={onOver}
        onMouseLeave={() => setActive(null, null)}
      >
        {shown.map((b) => {
          const e = entries.get(b.id)!;
          return (
            <div
              key={b.id}
              className={`tr-card tr-${b.type} ${b.tableNote ? "tr-table-note" : ""} ${redoing.has(b.id) ? "redoing" : ""}`}
              data-tr-for={b.id}
              data-level={b.type === "heading" ? Math.min(Math.max(b.level ?? 2, 1), 6) : undefined}
            >
              {b.tableNote && <span className="tr-note-label">표 설명</span>}
              {translationFragments(b, e).map((s, i) => <span key={i} className="tr-s" data-g={s.index == null ? undefined : `${b.id}#${s.index}`}><TrText text={s.text} /> </span>)}
            </div>
          );
        })}
        <div className="tr-grip left" onPointerDown={onGrip} />
      </aside>
      <div ref={marksRef} className="tr-marks" aria-hidden>
        {marks.map((m) => (
          <div key={m.id} className="tr-mark" data-tr-mark={m.id}>
            <span>{m.page}</span>
          </div>
        ))}
      </div>
    </>
  );
}
