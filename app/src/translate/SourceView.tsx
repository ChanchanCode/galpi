// 보기 B — 원본 ‖ 번역 (PLAN-AI §7.2·§7.3, D9·D11·D12).
//
// 지면을 책상 위 낱장처럼 연속 스크롤로 늘어놓고, 오른쪽에 쪽별 번역 카드를 세운다.
// 팬/줌 자체는 `useCanvas` 가 맡는다 — 보기 A 와 **같은 코드**를 쓴다.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PageInfo, PaperDocument } from "../types";
import type { PageMerge } from "../render/pagemerge";
import type { TrSource } from "./trBlocks";
import type { TrEntry } from "./useTranslation";
import { docScaleStyle, type Canvas } from "./useCanvas";
import { ZoomBar } from "./ZoomBar";
import { TrText } from "./TrText";
import { TR_WIDTH_DEFAULT } from "./useTranslation";
import {
  blockAt,
  parsePageText,
  placeLines,
  TL_FONT_FAMILY,
  TL_FONT_RATIO,
  TL_MEASURE_PX,
  type PageText,
  type PlacedLine,
} from "./textLayer";
import "./textlayer.css";

interface PageBox {
  id: string;
  bbox: [number, number, number, number];
}

const HANDOFF_MS = 420; // 카드 끝에서 캔버스로 넘어가는 관성을 막는 경계 잠금
const GAP = 24;
// 빈 배열을 매 렌더 새로 만들면 텍스트층 줄 목록 memo 가 번역 스트리밍마다 깨진다.
const NO_BOXES: PageBox[] = [];

interface Props {
  doc: PaperDocument;
  /** 캔버스는 **App 이 소유한다** — 보기를 오갈 때 이 컴포넌트가 언마운트돼도
   *  사용자가 맞춰 둔 배율·위치가 살아남아야 한다. */
  cv: Canvas;
  onDocW: (w: number) => void;
  /** 번역 컬럼을 띄울지 — 끄면 지면만 넓게 본다(보기 전환은 번역과 독립이다). */
  showTr: boolean;
  blocks: TrSource[];
  entries: Map<string, TrEntry>;
  width: number;
  onWidth: (n: number) => void;
  redoing: Set<string>;
  merge: PageMerge;
}

export function SourceView({ doc, cv, onDocW, showTr, blocks, entries, width, onWidth, redoing, merge }: Props) {
  const { z, baseW, canvasRef, panRef } = cv;
  const [live, setLive] = useState<Set<number>>(() => new Set([1, 2, 3]));

  // 쪽별 번역 블록. 페이지를 넘어 합쳐진 문단은 **시작한 쪽의 카드**에 남는다(§5.1).
  const byPage = useMemo(() => {
    const m = new Map<number, TrSource[]>();
    for (const b of blocks) {
      const arr = m.get(b.page);
      if (arr) arr.push(b);
      else m.set(b.page, [b]);
    }
    return m;
  }, [blocks]);

  // 이 쪽의 첫 문단이 앞 쪽 문단에 흡수됐는가 → '이어짐' 칩.
  const contFrom = useMemo(() => {
    const m = new Map<number, string>();
    const pageOf = new Map(doc.blocks.map((b) => [b.id, b.page]));
    for (const [absorbed, base] of merge.baseOf) {
      const p = pageOf.get(absorbed);
      const bp = pageOf.get(base);
      if (p != null && bp != null && bp < p && !m.has(p)) m.set(p, base);
    }
    return m;
  }, [doc.blocks, merge]);

  // 지면 위 호버 상자 (§7.4) — 쪽마다 [bbox, 가리킬 카드 id].
  // 페이지를 넘어 흡수된 조각도 상자를 갖는다: 그 조각을 짚으면 **앞 쪽 카드**를 가리켜야 한다(§5.1).
  // cardFor: 원래 블록 id → 가리킬 카드 id. 텍스트층 줄은 원래 블록 id 를 달고 있어서(인용 계약 §2.3)
  // 줄 위에서 호버할 때 이걸로 카드를 찾는다.
  const { boxesByPage, cardFor } = useMemo(() => {
    const cardOf = new Set(blocks.map((b) => b.id));
    const m = new Map<number, PageBox[]>();
    const cf = new Map<string, string>();
    for (const b of doc.blocks) {
      if (!b.bbox) continue;
      const target = cardOf.has(b.id) ? b.id : merge.baseOf.get(b.id);
      if (!target || !cardOf.has(target)) continue;
      const arr = m.get(b.page) ?? [];
      arr.push({ id: target, bbox: b.bbox });
      m.set(b.page, arr);
      cf.set(b.id, target);
    }
    return { boxesByPage: m, cardFor: cf };
  }, [doc.blocks, blocks, merge]);

  // 텍스트층 줄 → 블록 id 매칭용. 번역 대상이 아닌 블록(캡션·각주·참고문헌)도 인용 출처가 되므로 전부.
  const blockBoxesByPage = useMemo(() => {
    const m = new Map<number, PageBox[]>();
    for (const b of doc.blocks) {
      if (!b.bbox) continue;
      const arr = m.get(b.page) ?? [];
      arr.push({ id: b.id, bbox: b.bbox });
      m.set(b.page, arr);
    }
    return m;
  }, [doc.blocks]);

  useSelectionEnds(canvasRef);

  // 뷰포트 근처 쪽만 실체화 (§7.3) — 벡터 쪽은 DOM 노드가 쪽당 1,700~1,900개다.
  useEffect(() => {
    const root = document.querySelector(".reader-scroll");
    const el = canvasRef.current;
    if (!root || !el) return;
    const io = new IntersectionObserver(
      (ents) => {
        setLive((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const en of ents) {
            const n = Number((en.target as HTMLElement).dataset.page);
            if (en.isIntersecting && !next.has(n)) {
              next.add(n);
              changed = true;
            } else if (!en.isIntersecting && next.has(n)) {
              next.delete(n);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { root, rootMargin: "120% 0px" },
    );
    for (const s of el.querySelectorAll(".spread")) io.observe(s);
    return () => io.disconnect();
  }, [doc.doc_id, baseW, canvasRef]);

  // 손잡이는 확대된 화면 위에서 끌린다 → 이동량을 배율로 나눠야 손끝을 따라온다.
  const onGrip = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = width;
    const move = (ev: PointerEvent) => onWidth(w0 + (ev.clientX - x0) / Math.max(z, 0.01));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("tr-resizing");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.classList.add("tr-resizing");
  };

  // 카드 ↔ 지면 상자 양방향 하이라이트. 클래스만 토글하므로 리렌더가 없다.
  useEffect(() => {
    const root = canvasRef.current;
    if (!root || !showTr) return;
    let cur: string | null = null;
    const paint = (id: string | null) => {
      if (cur === id) return;
      for (const el of root.querySelectorAll(".tr-box.on, .tr-card.on-src")) el.classList.remove("on", "on-src");
      cur = id;
      if (!id) return;
      const esc = CSS.escape(id);
      for (const el of root.querySelectorAll(`.tr-box[data-tr-box="${esc}"]`)) el.classList.add("on");
      for (const el of root.querySelectorAll(`.tr-card[data-tr-for="${esc}"]`)) el.classList.add("on-src");
    };
    const onMove = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // 드래그 선택 중엔 덮개(.src-tl-end)가 층을 가린다 — 칠해 둔 것을 그대로 둔다.
      if (t?.classList?.contains("src-tl-end")) return;
      // 텍스트층 줄이 호버 상자 위에 놓인다 → 줄의 블록으로 카드를 찾는다.
      const line = t?.closest?.(".src-tl-line") as HTMLElement | null;
      if (line) {
        paint(cardFor.get(line.dataset.blockId ?? "") ?? null);
        return;
      }
      const hit = t?.closest?.(".tr-box, .tr-card") as HTMLElement | null;
      paint(hit ? (hit.dataset.trBox ?? hit.dataset.trFor ?? null) : null);
    };
    const onLeave = () => paint(null);
    root.addEventListener("mousemove", onMove);
    root.addEventListener("mouseleave", onLeave);
    return () => {
      root.removeEventListener("mousemove", onMove);
      root.removeEventListener("mouseleave", onLeave);
      paint(null);
    };
  }, [showTr, canvasRef, entries, cardFor]);

  const cardW = showTr ? width : 0;
  // **지면 폭은 카드 폭과 무관하다.** 카드를 넓히면 지면이 줄어드는 게 아니라
  // 전체가 캔버스보다 넓어지고, 남는 만큼은 팬으로 본다.
  const pageW = showTr ? Math.max(240, baseW - GAP - TR_WIDTH_DEFAULT) : baseW;
  const wantW = showTr ? pageW + GAP + cardW : baseW;
  useEffect(() => onDocW(wantW), [wantW, onDocW]);

  return (
    <div className="src-canvas" ref={canvasRef} onPointerDown={cv.onPointerDown}>
      <div className="src-pan" ref={panRef}>
        {/* 확정된 이동은 여기, 제스처 중 배율은 바깥(.src-pan)에. 둘을 겹치면 좌표 계산이 꼬인다. */}
        <div className="src-shift" ref={cv.shiftRef}>
          <div className="src-doc" style={{ width: wantW || undefined, ...docScaleStyle(z) }}>
            {doc.pages.map((p) => (
              <Spread
                key={p.index}
                page={p}
                docId={doc.doc_id}
                live={live.has(p.index)}
                pageW={pageW}
                cardW={cardW}
                showTr={showTr}
                items={byPage.get(p.index) ?? []}
                boxes={showTr ? boxesByPage.get(p.index) ?? NO_BOXES : NO_BOXES}
                blockBoxes={blockBoxesByPage.get(p.index) ?? NO_BOXES}
                entries={entries}
                redoing={redoing}
                contFrom={contFrom.get(p.index)}
                onGrip={onGrip}
              />
            ))}
          </div>
        </div>
      </div>
      {cv.zoomVisible && <ZoomBar z={z} onZoom={cv.zoomBy} onReset={cv.reset} />}
    </div>
  );
}


function Spread({
  page,
  docId,
  live,
  pageW,
  cardW,
  showTr,
  items,
  boxes,
  blockBoxes,
  entries,
  redoing,
  contFrom,
  onGrip,
}: {
  page: PageInfo;
  docId: string;
  live: boolean;
  pageW: number;
  cardW: number;
  showTr: boolean;
  items: TrSource[];
  boxes: PageBox[];
  blockBoxes: PageBox[];
  entries: Map<string, TrEntry>;
  redoing: Set<string>;
  contFrom?: string;
  onGrip: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      className="spread"
      data-page={page.index}
      style={{ gridTemplateColumns: showTr ? `${pageW}px ${cardW}px` : `${pageW}px`, gap: showTr ? GAP : 0 }}
    >
      <div
        className="pagehalf"
        style={{ aspectRatio: `${page.width_pt} / ${page.height_pt}` }}
        data-vector={page.is_vector || undefined}
      >
        {live && <PageArt page={page} docId={docId} />}
        {boxes.map((b, i) => {
          const [x0, y0, x1, y1] = b.bbox;
          return (
            <div
              key={i}
              className="tr-box"
              data-tr-box={b.id}
              style={{
                left: `${(x0 / page.width_pt) * 100}%`,
                top: `${(y0 / page.height_pt) * 100}%`,
                width: `${((x1 - x0) / page.width_pt) * 100}%`,
                height: `${((y1 - y0) / page.height_pt) * 100}%`,
              }}
            />
          );
        })}
        {/* 호버 상자 **위**에 둔다 — 층은 pointer-events:none 이고 줄만 이벤트를 받으므로 틈에서는 상자가 산다. */}
        {live && page.text && <TextLayer page={page} docId={docId} blocks={blockBoxes} />}
        <span className="pagenum">{page.index}</span>
      </div>
      {showTr && (
      <div className="trhalf">
        <div className="trscroll" onWheel={handoff}>
          {contFrom && (
            <button
              className="tr-cont"
              onClick={() => flashCard(contFrom)}
              title="앞 쪽 문단에서 이어짐"
            >
              ⤶
            </button>
          )}
          {items.map((b) => {
            const e = entries.get(b.id);
            if (!e) return null;
            return (
              <p
                key={b.id}
                className={`tr-card tr-${b.type} ${redoing.has(b.id) ? "redoing" : ""}`}
                data-tr-for={b.id}
                data-level={b.type === "heading" ? Math.min(Math.max(b.level ?? 2, 1), 6) : undefined}
              >
                {e.spans?.length ? e.spans.map((s, i) => (
                  <span key={i} className="tr-s" data-g={`${b.id}#${i}`}><TrText text={s.ko} /> </span>
                )) : <TrText text={e.ko} />}
              </p>
            );
          })}
        </div>
        <div className="tr-grip" onPointerDown={onGrip} />
      </div>
      )}
    </div>
  );
}

// 카드 끝에서 캔버스로 넘어갈 때 트랙패드 관성이 화면을 날린다 — 경계에서 한 박자 잠근다(§7.2).
const lastActive = new WeakMap<EventTarget, number>();
function handoff(e: React.WheelEvent<HTMLDivElement>) {
  const el = e.currentTarget;
  const atTop = el.scrollTop <= 0;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  const boundary = (e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom);
  const t = lastActive.get(el) ?? 0;
  if (boundary) {
    if (e.timeStamp - t < HANDOFF_MS) e.preventDefault();
    return;
  }
  lastActive.set(el, e.timeStamp);
}

function flashCard(id: string): void {
  const el = document.querySelector<HTMLElement>(`.tr-card[data-tr-for="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1200);
}

// 벡터 쪽은 SVG 를 인라인해야 `fill: var(--fg)` 한 줄로 테마가 먹는다(D6).
// <img> 로 넣으면 CSS 가 문서 경계를 못 넘어 잉크색이 항상 검정으로 남는다.
function PageArt({ page, docId }: { page: PageInfo; docId: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const wantSvg = !!(page.is_vector && page.svg);

  useEffect(() => {
    if (!wantSvg) return;
    let alive = true;
    fetch(window.paperAPI.assetUrl(docId, page.svg!))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => alive && setSvg(t))
      .catch(() => alive && setSvg(null));
    return () => {
      alive = false;
    };
  }, [wantSvg, docId, page.svg]);

  if (wantSvg) {
    return svg ? (
      <div className="pagesvg" dangerouslySetInnerHTML={{ __html: svg }} />
    ) : null;
  }
  return <img src={window.paperAPI.assetUrl(docId, page.image)} alt={`p.${page.index}`} draggable={false} />;
}

// ── 원본 지면 텍스트층 (SPEC-CHAT §4.8) ─────────────────────────────────
// SVG 는 글리프가 path 라 선택이 안 된다. 쪽마다 줄 좌표(text.json)를 받아 투명 글자를 겹친다.
// 좌표 계산은 textLayer.ts(순수) — 여기서는 받기·측정·DOM 만 한다.

interface LoadedText {
  pt: PageText;
  lines: PlacedLine[];
}

// 실체화는 스크롤할 때마다 붙었다 떨어진다 — 받은 줄·측정값을 모듈에 두어 다시 받거나 재지 않는다.
const TEXT_CACHE_MAX = 240; // 쪽 수. 문서 몇 편을 오가도 충분하고 줄 데이터라 작다(쪽당 수 KB)
const textCache = new Map<string, Promise<LoadedText | null>>();

function loadPageText(url: string): Promise<LoadedText | null> {
  const hit = textCache.get(url);
  if (hit) return hit;
  const p: Promise<LoadedText | null> = fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((raw) => {
      const pt = parsePageText(raw);
      return pt ? { pt, lines: placeLines(pt, measureLine) } : null;
    })
    .catch(() => null)
    .then((v) => {
      // 실패는 캐시하지 않는다 — 다음 실체화 때 다시 받는다.
      if (!v && textCache.get(url) === p) textCache.delete(url);
      return v;
    });
  textCache.set(url, p);
  if (textCache.size > TEXT_CACHE_MAX) {
    const oldest = textCache.keys().next().value;
    if (oldest !== undefined) textCache.delete(oldest);
  }
  return p;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
const widthCache = new Map<string, number>();
/** TL_MEASURE_PX 크기에서의 글자 폭. DOM 레이아웃을 건드리지 않게 캔버스로 잰다. */
function measureLine(t: string): number {
  const hit = widthCache.get(t);
  if (hit !== undefined) return hit;
  if (measureCtx === undefined) {
    measureCtx = document.createElement("canvas").getContext("2d");
    if (measureCtx) {
      measureCtx.font = `${TL_MEASURE_PX}px ${TL_FONT_FAMILY}`;
      measureCtx.fontKerning = "none"; // textlayer.css 의 font-kerning:none 과 짝 — 한쪽만 커닝하면 줄 끝이 어긋난다
    }
  }
  const w = measureCtx ? measureCtx.measureText(t).width : 0;
  if (widthCache.size > 20000) widthCache.clear();
  widthCache.set(t, w);
  return w;
}

const LAYER_FONT: React.CSSProperties = { fontFamily: TL_FONT_FAMILY, lineHeight: 1 / TL_FONT_RATIO };

function TextLayer({ page, docId, blocks }: { page: PageInfo; docId: string; blocks: PageBox[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const url = window.paperAPI.assetUrl(docId, page.text!);
  // url 을 같이 들고 있어야 문서가 바뀌는 순간 옛 쪽 줄이 새 지면 위에 한 프레임도 안 남는다.
  const [got, setGot] = useState<{ url: string; v: LoadedText | null } | null>(null);
  const data = got?.url === url ? got.v : null;

  useEffect(() => {
    let alive = true;
    void loadPageText(url).then((v) => {
      if (alive) setGot({ url, v });
    });
    return () => {
      alive = false;
    };
  }, [url]);

  const pageWpt = data?.pt.w ?? 0;
  const pageHpt = data?.pt.h ?? 0;
  // 벡터 쪽은 층을 SVG 와 같은 비율 상자로 맞춘다(textlayer.css `--tl-ar`).
  const layerStyle = useMemo(
    () => (pageWpt ? ({ ...LAYER_FONT, "--tl-ar": `${pageWpt} / ${pageHpt}` } as React.CSSProperties) : LAYER_FONT),
    [pageWpt, pageHpt],
  );

  // --tl-s = 렌더 폭(px) ÷ 쪽 폭(pt). getComputedStyle 은 `zoom` 아래에서도 확대 전 CSS px 을 준다(실측) —
  // getBoundingClientRect 는 확대 뒤 값이라 그걸 쓰면 글자가 배율만큼 한 번 더 커진다.
  // 쪽 폭·줌이 바뀌면 ResizeObserver 로 이 변수 하나만 고친다(줄은 다시 그리지 않는다).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !pageWpt) return;
    const apply = () => {
      const w = parseFloat(getComputedStyle(el).width);
      if (w > 0) el.style.setProperty("--tl-s", String(w / pageWpt));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pageWpt]);

  // 드래그 선택용 덮개 — React 밖에서 만든다. useSelectionEnds 가 줄 사이로 옮겨 다니므로
  // React 가 관리하는 자식이면 재조정 때 위치가 꼬인다.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const end = document.createElement("div");
    end.className = "src-tl-end";
    el.appendChild(end);
    return () => end.remove();
  }, []);

  const spans = useMemo(
    () =>
      data?.lines.map((l, i) => (
        <Fragment key={i}>
          <span
            className="src-tl-line"
            data-block-id={blockAt(l.cx, l.cy, blocks)}
            style={{
              left: `${l.left}%`,
              top: `${l.top}%`,
              fontSize: `calc(var(--tl-s, 1) * ${l.font}px)`,
              transform: l.transform,
            }}
          >
            {l.t}
          </span>
          <br />
        </Fragment>
      )),
    [data, blocks],
  );

  return (
    <div ref={ref} className="src-textlayer" data-page={page.index} style={layerStyle}>
      {spans}
    </div>
  );
}

// 텍스트층 드래그 선택이 줄 사이 틈에서 튀지 않게 한다 (pdf.js 의 endOfContent 기법).
// 틈에서는 포인터가 줄이 아니라 아래 지면(svg/img)에 맞는다 → Chromium 은 선택 끝을 그 요소의
// DOM 자리, 즉 **쪽 맨 앞**으로 잡아 드래그 중 선택이 쪽 머리까지 번쩍 늘었다 줄었다 한다.
// 드래그 동안만 층 전체를 덮는 빈 div(.src-tl-end)를 **지금 움직이는 선택 끝 줄 바로 옆**으로
// 옮겨 두면 틈이 그 자리로 매핑돼 선택이 많아야 한 줄만큼만 움직인다.
function useSelectionEnds(canvasRef: React.RefObject<HTMLDivElement>) {
  useEffect(() => {
    const root = canvasRef.current;
    if (!root) return;
    let dragging = false;
    let prev: Range | null = null;
    const on = new Set<HTMLElement>();
    const park = (end: HTMLElement) => {
      end.classList.remove("on");
      end.parentElement?.appendChild(end);
      on.delete(end);
    };
    const resetAll = () => {
      for (const end of [...on]) park(end);
      prev = null;
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      dragging = e.button === 0 && !!t?.closest?.(".src-tl-line") && root.contains(t);
      prev = null;
    };
    const onUp = () => {
      dragging = false;
      resetAll();
    };
    const onSel = () => {
      if (!dragging) return;
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0) {
        resetAll();
        return;
      }
      const range = sel.getRangeAt(0);
      for (const layer of root.querySelectorAll<HTMLElement>(".src-textlayer")) {
        const end = layer.querySelector<HTMLElement>(":scope > .src-tl-end");
        if (!end) continue;
        if (range.intersectsNode(layer)) {
          end.classList.add("on");
          on.add(end);
        } else if (on.has(end)) park(end);
      }
      // 어느 끝이 움직였나 — 끝점이 그대로면 시작점을 끄는 중(위로 드래그).
      const startMoved =
        !!prev &&
        (range.compareBoundaryPoints(Range.END_TO_END, prev) === 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, prev) === 0);
      prev = range.cloneRange();
      const line = startMoved
        ? boundaryLine(range.startContainer, range.startOffset, true)
        : boundaryLine(range.endContainer, range.endOffset, false);
      const end = line?.parentElement?.querySelector<HTMLElement>(":scope > .src-tl-end");
      if (!line || !end) return;
      // 이미 제자리면 건드리지 않는다 — DOM 을 옮기면 selectionchange 가 다시 올 수 있다.
      if (startMoved) {
        if (line.previousSibling !== end) line.before(end);
      } else if (line.nextSibling !== end) line.after(end);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
    document.addEventListener("selectionchange", onSel);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      document.removeEventListener("selectionchange", onSel);
      resetAll();
    };
  }, [canvasRef]);
}

/** 선택 경계점에 가장 가까운 텍스트층 줄. 끝점이 줄 맨 앞(offset 0)이면 그 줄은 아직 선택 밖이라 앞 줄. */
function boundaryLine(node: Node, offset: number, isStart: boolean): HTMLElement | null {
  const isLine = (n: Node | null) => n instanceof HTMLElement && n.classList.contains("src-tl-line");
  const walk = (n: Node | null, back: boolean): HTMLElement | null => {
    while (n && !isLine(n)) n = back ? n.previousSibling : n.nextSibling;
    return n as HTMLElement | null;
  };
  if (node.nodeType === Node.TEXT_NODE) {
    const line = node.parentElement?.closest<HTMLElement>(".src-tl-line") ?? null;
    if (!line) return null;
    return !isStart && offset === 0 ? walk(line.previousSibling, true) ?? line : line;
  }
  if (!(node instanceof HTMLElement)) return null;
  if (isLine(node)) return node;
  if (!node.classList.contains("src-textlayer")) return null;
  return isStart ? walk(node.childNodes[offset] ?? null, false) : walk(node.childNodes[offset - 1] ?? null, true);
}
