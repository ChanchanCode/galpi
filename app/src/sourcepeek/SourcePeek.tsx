// 원본 대조 (Source Peek, 명세 §9) — 검사 모드 + bbox crop 팝오버 + 디버그 오버레이.
//
// 좌표계 (§9.3, Phase 1 캘리브레이션으로 확정):
//   bbox 는 PDF point, **좌상단 원점**(fitz 좌표계). 페이지 PNG 도 좌상단 원점.
//   → y 뒤집기 없음. 변환은 축별 균일 스케일뿐:
//        scale = image_px / size_pt  (= dpi/72, 예: 200/72 ≈ 2.778)
//   디버그 오버레이(Alt+Shift+D)로 박스 정합을 눈으로 검증할 수 있다.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Block, PageInfo, PaperDocument } from "../types";
import { useStore } from "../store/useStore";
import { isEditableTarget, matchCombo } from "../keys/keymap";

const PAD_PT = 6; // crop 여백(PDF point) — 맥락이 보이도록 살짝 포함 (§9.2)
const MIN_SCALE = 0.1;
const MAX_SCALE = 16;
const HEADER_H = 38;

interface CropTarget {
  block: Block;
  page: PageInfo;
  // 클릭 지점(팝오버 배치 기준)
  anchorX: number;
  anchorY: number;
}

interface Props {
  doc: PaperDocument;
  /** 외부(리더 바 🔍 버튼)에서 토글하는 고정 검사 모드 */
  sticky: boolean;
  onExitSticky: () => void;
}

export function SourcePeek({ doc, sticky, onExitSticky }: Props) {
  const peekCombo = useStore((s) => s.keymap.sourcePeek);
  const [altHeld, setAltHeld] = useState(false);
  const [target, setTarget] = useState<CropTarget | null>(null);
  const [debugPage, setDebugPage] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const blockById = useMemo(() => {
    const m = new Map<string, Block>();
    for (const b of doc.blocks) m.set(b.id, b);
    return m;
  }, [doc]);

  const pageByIndex = useMemo(() => {
    const m = new Map<number, PageInfo>();
    for (const p of doc.pages) m.set(p.index, p);
    return m;
  }, [doc]);

  const inspecting = sticky || altHeld;

  // 검사 모드일 때 body 에 표식 → CSS 가 커서/아웃라인 처리
  useEffect(() => {
    if (inspecting) document.body.dataset.inspect = "on";
    else delete document.body.dataset.inspect;
    return () => {
      delete document.body.dataset.inspect;
    };
  }, [inspecting]);

  // Alt(Option) 누름 → 일시 검사 모드. Alt+Shift+D → 디버그 오버레이.
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        setDebugPage((p) => (p == null ? 1 : null));
        return;
      }
      if (e.key === "Alt") setAltHeld(true);
      if (e.key === "Escape") {
        setTarget(null);
        setDebugPage(null);
        if (sticky) onExitSticky();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Alt") setAltHeld(false);
    };
    const onBlur = () => setAltHeld(false);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [sticky, onExitSticky]);

  // 단축키(기본 G): 선택/현재 위치의 블록 원본 crop 열기. (검사 모드 없이 바로)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (!matchCombo(e, peekCombo)) return;
      const content = document.querySelector(".reader-content") as HTMLElement | null;
      if (!content) return;

      // 1) 선택이 본문 안이면 그 블록 / 2) 아니면 화면 세로 중앙에 걸친 블록
      let el: HTMLElement | null = null;
      let anchorX = window.innerWidth / 2;
      let anchorY = window.innerHeight / 2;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        if (content.contains(range.commonAncestorContainer)) {
          el = (range.startContainer.nodeType === 1
            ? (range.startContainer as HTMLElement)
            : range.startContainer.parentElement
          )?.closest("[data-block-id]") as HTMLElement | null;
          const r = range.getBoundingClientRect();
          anchorX = r.left + r.width / 2;
          anchorY = r.top + r.height / 2;
        }
      }
      if (!el) {
        const blocks = Array.from(content.querySelectorAll<HTMLElement>("[data-block-id]"));
        const midY = window.innerHeight / 2;
        let best: HTMLElement | null = null;
        let bestDist = Infinity;
        for (const b of blocks) {
          const r = b.getBoundingClientRect();
          if (r.bottom < 0 || r.top > window.innerHeight) continue;
          const center = r.top + r.height / 2;
          const dist = Math.abs(center - midY);
          if (dist < bestDist) {
            bestDist = dist;
            best = b;
          }
        }
        el = best;
        if (el) {
          const r = el.getBoundingClientRect();
          anchorX = Math.min(window.innerWidth - 40, r.left + r.width / 2);
          anchorY = r.top + r.height / 2;
        }
      }
      if (!el) return;
      const block = blockById.get(el.dataset.blockId!);
      if (!block) return;
      const page = pageByIndex.get(block.page);
      if (!page) return; // bbox 없는 합성 블록은 원본 없음
      e.preventDefault();
      setTarget({ block, page, anchorX, anchorY });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [peekCombo, blockById, pageByIndex]);

  // 검사 모드에서 블록 클릭 → 원본 crop 팝오버. (캡처 단계에서 선택/링크 동작 가로채기)
  useEffect(() => {
    if (!inspecting) return;
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.("[data-block-id]") as HTMLElement | null;
      if (!el) return;
      const content = el.closest(".reader-content");
      if (!content) return;
      const block = blockById.get(el.dataset.blockId!);
      if (!block) return;
      const page = pageByIndex.get(block.page);
      if (!page) return; // bbox 없는 합성 블록(각주 목록 등)은 페이지 정보 없음 → 무시
      e.preventDefault();
      e.stopPropagation();
      setTarget({ block, page, anchorX: e.clientX, anchorY: e.clientY });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [inspecting, blockById, pageByIndex]);

  // (바깥 클릭으로 닫지 않음 — 이제 자유 이동/크기조절 창이라 ✕ 또는 Esc 로만 닫는다.
  //  원문과 reflow 를 나란히 두고 본문을 만져도 창이 사라지지 않게.)

  return (
    <>
      {target && (
        <CropPopover
          target={target}
          docId={doc.doc_id}
          boxRef={boxRef}
          onClose={() => setTarget(null)}
        />
      )}
      {debugPage != null && (
        <DebugOverlay
          doc={doc}
          page={debugPage}
          onPage={setDebugPage}
          onClose={() => setDebugPage(null)}
        />
      )}
    </>
  );
}

// ── crop 좌표 계산 (§9.3) ───────────────────────────────────────────────
// bbox(PDF point, 좌상단 원점) → 페이지 PNG 픽셀 영역. y 뒤집기 없음.
function cropRectPx(block: Block, page: PageInfo) {
  const sx = page.image_width_px / page.width_pt;
  const sy = page.image_height_px / page.height_pt;
  // bbox 없으면 페이지 전체로 폴백 (§5: "페이지 전체")
  const [x0, y0, x1, y1] = block.bbox ?? [0, 0, page.width_pt, page.height_pt];
  // 여백 포함 + 페이지 경계 클램프
  const px0 = Math.max(0, x0 - PAD_PT) * sx;
  const py0 = Math.max(0, y0 - PAD_PT) * sy;
  const px1 = Math.min(page.width_pt, x1 + PAD_PT) * sx;
  const py1 = Math.min(page.height_pt, y1 + PAD_PT) * sy;
  return { px0, py0, w: px1 - px0, h: py1 - py0 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

interface WinState {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface ViewState {
  scale: number; // 화면px / 이미지px
  ox: number; // 이미지 변환 offset (뷰포트 좌표)
  oy: number;
}
type DragMode = "win" | "resize" | "pan";

// 자유 이동·크기조절·줌/팬 되는 원본 뷰어 창. 처음엔 클릭한 블록 bbox 를 화면에 맞춰 보여주고,
// 이후엔 일반 이미지 뷰어처럼 드래그(팬)·휠(줌)·헤더 드래그(이동)·모서리 드래그(크기)로 조작.
function CropPopover({
  target,
  docId,
  boxRef,
  onClose,
}: {
  target: CropTarget;
  docId: string;
  boxRef: React.RefObject<HTMLDivElement>;
  onClose: () => void;
}) {
  const { block, page } = target;
  const crop = cropRectPx(block, page);
  const imgUrl = window.paperAPI.assetUrl(docId, page.image);
  const viewportRef = useRef<HTMLDivElement>(null);

  // 초기 창 위치/크기 — 클릭 지점 옆, 화면 안으로 클램프.
  const [win, setWin] = useState<WinState>(() => {
    const w = Math.min(560, window.innerWidth - 40);
    const h = Math.min(Math.round(window.innerHeight * 0.62), 620);
    let x = target.anchorX + 24;
    if (x + w > window.innerWidth - 12) x = target.anchorX - w - 24;
    x = clamp(x, 12, Math.max(12, window.innerWidth - w - 12));
    let y = clamp(target.anchorY - h / 2, 12, Math.max(12, window.innerHeight - h - 12));
    return { x, y, w, h };
  });

  // 초기 뷰 — bbox 크롭이 본문 영역에 맞도록 fit (작은 블록은 확대됨).
  const [view, setView] = useState<ViewState>(() => {
    const vw = win.w;
    const vh = win.h - HEADER_H;
    const s = clamp(Math.min(vw / crop.w, vh / crop.h) || 1, MIN_SCALE, MAX_SCALE);
    const cx = crop.px0 + crop.w / 2;
    const cy = crop.py0 + crop.h / 2;
    return { scale: s, ox: vw / 2 - cx * s, oy: vh / 2 - cy * s };
  });

  const viewW = win.w;
  const viewH = win.h - HEADER_H;

  // ── 드래그(창 이동 / 크기조절 / 팬) ──────────────────────────────
  const drag = useRef<{ mode: DragMode; sx: number; sy: number; win: WinState; view: ViewState } | null>(null);
  const onMove = useRef((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (d.mode === "win") {
      setWin((w) => ({
        ...w,
        x: clamp(d.win.x + dx, -w.w + 80, window.innerWidth - 80),
        y: clamp(d.win.y + dy, 0, window.innerHeight - HEADER_H),
      }));
    } else if (d.mode === "resize") {
      setWin((w) => ({
        ...w,
        w: clamp(d.win.w + dx, 260, window.innerWidth - 16),
        h: clamp(d.win.h + dy, 180, window.innerHeight - 16),
      }));
    } else {
      setView((v) => ({ ...v, ox: d.view.ox + dx, oy: d.view.oy + dy }));
    }
  });
  const onUp = useRef(() => {
    drag.current = null;
    window.removeEventListener("pointermove", onMove.current);
    window.removeEventListener("pointerup", onUp.current);
    document.body.classList.remove("peek-dragging");
  });
  const startDrag = (mode: DragMode, e: React.PointerEvent) => {
    e.preventDefault();
    drag.current = { mode, sx: e.clientX, sy: e.clientY, win: { ...win }, view: { ...view } };
    window.addEventListener("pointermove", onMove.current);
    window.addEventListener("pointerup", onUp.current);
    if (mode === "pan") document.body.classList.add("peek-dragging");
  };
  useEffect(() => () => onUp.current(), []); // 언마운트 시 리스너 정리

  // ── 줌 ───────────────────────────────────────────────────────────
  const zoomAt = (mx: number, my: number, factor: number) => {
    setView((v) => {
      const ns = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      const ipx = (mx - v.ox) / v.scale;
      const ipy = (my - v.oy) / v.scale;
      return { scale: ns, ox: mx - ipx * ns, oy: my - ipy * ns };
    });
  };
  const onWheel = (e: React.WheelEvent) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
  };
  const fit = () => {
    const s = clamp(Math.min(viewW / crop.w, viewH / crop.h) || 1, MIN_SCALE, MAX_SCALE);
    const cx = crop.px0 + crop.w / 2;
    const cy = crop.py0 + crop.h / 2;
    setView({ scale: s, ox: viewW / 2 - cx * s, oy: viewH / 2 - cy * s });
  };

  return (
    <div
      ref={boxRef}
      className="peek-window"
      style={{ left: win.x, top: win.y, width: win.w, height: win.h }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="peek-head" onPointerDown={(e) => startDrag("win", e)}>
        <span className="peek-title">
          원본 · p.{block.page} · {typeLabel(block.type)}
        </span>
        <div className="peek-tools" onPointerDown={(e) => e.stopPropagation()}>
          <button className="peek-btn" onClick={() => zoomAt(viewW / 2, viewH / 2, 1 / 1.25)} title="축소">−</button>
          <span className="peek-zoom" title="현재 배율(이미지 픽셀 기준)">{Math.round(view.scale * 100)}%</span>
          <button className="peek-btn" onClick={() => zoomAt(viewW / 2, viewH / 2, 1.25)} title="확대">＋</button>
          <button className="peek-btn" onClick={fit} title="블록에 맞춤">맞춤</button>
          <button className="peek-btn peek-close" onClick={onClose} aria-label="닫기" title="닫기 (Esc)">✕</button>
        </div>
      </div>
      <div
        ref={viewportRef}
        className="peek-view"
        style={{ height: viewH }}
        onPointerDown={(e) => startDrag("pan", e)}
        onWheel={onWheel}
      >
        <img
          src={imgUrl}
          draggable={false}
          alt={`원본 p.${block.page}`}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: page.image_width_px,
            height: page.image_height_px,
            transformOrigin: "0 0",
            transform: `translate(${view.ox}px, ${view.oy}px) scale(${view.scale})`,
          }}
        />
      </div>
      <div className="peek-resize" onPointerDown={(e) => startDrag("resize", e)} title="크기 조절" />
    </div>
  );
}

// ── 디버그 오버레이 (§9.3-2) — bbox 정합 눈 검증 ─────────────────────────
function DebugOverlay({
  doc,
  page,
  onPage,
  onClose,
}: {
  doc: PaperDocument;
  page: number;
  onPage: (p: number) => void;
  onClose: () => void;
}) {
  const pageInfo = doc.pages.find((p) => p.index === page);
  const blocks = doc.blocks.filter((b) => b.page === page && b.bbox);

  // 페이지 이미지를 화면에 맞게 축소 표시할 비율.
  const fit = pageInfo
    ? Math.min(
        (window.innerWidth - 120) / pageInfo.image_width_px,
        (window.innerHeight - 120) / pageInfo.image_height_px,
      )
    : 1;

  if (!pageInfo) return null;
  const sx = pageInfo.image_width_px / pageInfo.width_pt;
  const sy = pageInfo.image_height_px / pageInfo.height_pt;
  const dispW = Math.round(pageInfo.image_width_px * fit);
  const dispH = Math.round(pageInfo.image_height_px * fit);

  return (
    <div className="peek-debug" onClick={onClose}>
      <div className="peek-debug-bar" onClick={(e) => e.stopPropagation()}>
        <button disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ◀
        </button>
        <span>
          디버그 오버레이 · p.{page}/{doc.page_count} · 박스 {blocks.length}개
        </span>
        <button disabled={page >= doc.page_count} onClick={() => onPage(page + 1)}>
          ▶
        </button>
        <button className="peek-debug-x" onClick={onClose}>
          닫기 (Esc)
        </button>
      </div>
      <div
        className="peek-debug-stage"
        style={{ width: dispW, height: dispH }}
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={window.paperAPI.assetUrl(doc.doc_id, pageInfo.image)}
          width={dispW}
          height={dispH}
          alt={`page ${page}`}
        />
        {blocks.map((b) => {
          const [x0, y0, x1, y1] = b.bbox!;
          return (
            <div
              key={b.id}
              className="peek-debug-box"
              data-type={b.type}
              style={{
                left: x0 * sx * fit,
                top: y0 * sy * fit,
                width: (x1 - x0) * sx * fit,
                height: (y1 - y0) * sy * fit,
              }}
              title={`${b.id} · ${b.type}`}
            >
              <span className="peek-debug-tag">{b.type}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function typeLabel(t: Block["type"]): string {
  const m: Record<string, string> = {
    heading: "제목",
    paragraph: "본문",
    formula: "수식",
    table: "표",
    figure: "그림",
    caption: "캡션",
    list: "목록",
    footnote: "각주",
    reference: "참고문헌",
  };
  return m[t] ?? t;
}
