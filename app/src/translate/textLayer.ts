// 원본 지면 텍스트층 — 줄 좌표(pt) → 투명 글자 span 배치값 (SPEC-CHAT §4.8). 순수 함수, DOM 없음.
//
// 원본 모드 SVG 는 글리프가 path(text_as_path)라 드래그 선택이 안 된다. 파이프라인이 쪽마다
// 줄 좌표를 뽑아 두면(`pages/page-N.text.json`, rasterize.py) 그 자리에 같은 글자를 투명하게 겹친다.
//
// 좌표 전략:
//   · 위치는 **쪽 비율(%)** — 호버 상자(.tr-box)와 같은 방식이라 쪽 폭·줌(`zoom`)이 바뀌어도 레이아웃이 따라온다.
//   · 글자 크기만 px 이 필요하다. 줄마다 `calc(var(--tl-s) * Npx)` 로 두고 쪽마다 `--tl-s`
//     (렌더 폭 px ÷ 쪽 폭 pt) 하나만 갱신한다 → 창 크기가 바뀌어도 줄 수백 개를 다시 그리지 않는다.
//   · scaleX 는 배율과 무관하다 — 글자 폭은 글자 크기에 비례하므로 pt 공간에서 한 번 구하면 끝이다.

export type QuarterTurn = 0 | 90 | 180 | 270;

/** 한 줄. r 이 없으면 평범한 bbox(좌상단 x,y). 회전된 줄은 x,y 가 글 방향 기준 좌상단 모서리,
 *  w 가 글 방향 길이, h 가 수직 두께다(rasterize.py `page_text_lines`). */
export interface TextLine {
  x: number;
  y: number;
  w: number;
  h: number;
  t: string;
  r?: QuarterTurn;
}

export interface PageText {
  w: number;
  h: number;
  lines: TextLine[];
}

export interface PlacedLine {
  t: string;
  /** 쪽 폭 대비 % */
  left: number;
  /** 쪽 높이 대비 % */
  top: number;
  /** 글자 크기(pt). 화면에는 `--tl-s` 를 곱해 px 로 건다. */
  font: number;
  /** `rotate(..) scaleX(..)` — transform-origin 0 0 기준 */
  transform: string;
  /** 줄 중심(pt) — 블록 bbox 매칭용 */
  cx: number;
  cy: number;
}

/** 글자 크기 = 줄 높이 × 0.85. 나머지는 line-height(1/0.85)로 채워 선택 칠이 줄 bbox 를 덮게 한다. */
export const TL_FONT_RATIO = 0.85;
/** measureText 기준 크기(px). 이 크기로 한 번 재고 비례로 환산한다. */
export const TL_MEASURE_PX = 100;
/** 캔버스 측정과 DOM 이 **같은 글꼴**이어야 scaleX 가 맞는다(실측: 100px 에서 폭 차 0.002px).
 *  논문 본문(Times 류)과 글자 폭 분포가 비슷해야 줄 중간 글자 위치도 덜 어긋난다. */
export const TL_FONT_FAMILY = '"Times New Roman", Times, serif';

// 줄 방향 단위 벡터 (y 아래로 증가, 각도는 시계 방향 = CSS rotate)
const DIRS: Record<QuarterTurn, readonly [number, number]> = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] };

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** text.json 검증 — 깨진 줄은 버리고, 쓸 줄이 하나도 없으면 null. */
export function parsePageText(raw: unknown): PageText | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { w?: unknown; h?: unknown; lines?: unknown };
  if (!fin(o.w) || !fin(o.h) || o.w <= 0 || o.h <= 0 || !Array.isArray(o.lines)) return null;
  const lines: TextLine[] = [];
  for (const l of o.lines as Array<Record<string, unknown>>) {
    if (!l || typeof l !== "object") continue;
    const { x, y, w, h, t, r } = l;
    if (!fin(x) || !fin(y) || !fin(w) || !fin(h) || w <= 0 || h <= 0) continue;
    if (typeof t !== "string" || !t) continue;
    if (r !== undefined && r !== 0 && r !== 90 && r !== 180 && r !== 270) continue;
    lines.push(r ? { x, y, w, h, t, r: r as QuarterTurn } : { x, y, w, h, t });
  }
  return lines.length ? { w: o.w, h: o.h, lines } : null;
}

/** 줄 상자 중심(pt). 회전된 줄은 모서리 + 글 방향 w/2 + 수직 h/2. */
export function lineCenter(l: TextLine): [number, number] {
  const [dx, dy] = DIRS[l.r ?? 0];
  return [l.x + (l.w / 2) * dx - (l.h / 2) * dy, l.y + (l.w / 2) * dy + (l.h / 2) * dx];
}

/** 글자 크기 fontPt 로 그렸을 때 폭이 targetW 가 되게 하는 가로 배율.
 *  measuredAtBase = TL_MEASURE_PX 크기에서 잰 폭. 못 쟀으면(0) 1 — 선택은 되되 폭만 어긋난다. */
export function fitScaleX(targetW: number, fontPt: number, measuredAtBase: number): number {
  const natural = (measuredAtBase * fontPt) / TL_MEASURE_PX;
  if (!(natural > 0) || !(targetW > 0)) return 1;
  return Math.min(50, Math.max(0.02, targetW / natural));
}

/** 렌더 폭(px, 확대 전 CSS px) ÷ 쪽 폭(pt). */
export function pxPerPt(renderedW: number, pageWpt: number): number {
  return renderedW > 0 && pageWpt > 0 ? renderedW / pageWpt : 1;
}

const num = (v: number) => String(Math.round(v * 1e5) / 1e5);

export function placeLine(l: TextLine, page: { w: number; h: number }, measure: (t: string) => number): PlacedLine {
  const font = l.h * TL_FONT_RATIO;
  const sx = fitScaleX(l.w, font, measure(l.t));
  const [cx, cy] = lineCenter(l);
  return {
    t: l.t,
    left: (l.x / page.w) * 100,
    top: (l.y / page.h) * 100,
    font,
    transform: `${l.r ? `rotate(${l.r}deg) ` : ""}scaleX(${num(sx)})`,
    cx,
    cy,
  };
}

export function placeLines(pt: PageText, measure: (t: string) => number): PlacedLine[] {
  return pt.lines.map((l) => placeLine(l, pt, measure));
}

/** 점을 품은 블록 중 **가장 작은** 것 — 그림 bbox 안의 캡션처럼 겹치면 안쪽이 맞다. */
export function blockAt(
  x: number,
  y: number,
  boxes: ReadonlyArray<{ id: string; bbox: readonly [number, number, number, number] }>,
): string | undefined {
  let best: string | undefined;
  let bestArea = Infinity;
  for (const b of boxes) {
    const [x0, y0, x1, y1] = b.bbox;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    const a = (x1 - x0) * (y1 - y0);
    if (a < bestArea) {
      bestArea = a;
      best = b.id;
    }
  }
  return best;
}
