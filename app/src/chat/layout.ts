// 채팅 패널 배치 — 도킹(좌/우)·플로팅 사각형 계산만 모았다(React·DOM 없음).
// settings.json 최상위 `chatLayout` 로 저장된다(saveSettings 가 최상위 얕은 병합이라 다른 키와 안 부딪힌다).
import type { ChatTab } from "./chatBus";

export type ChatMode = "right" | "left" | "float";
export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface ChatLayout {
  mode: ChatMode;
  width: number; // 도킹 폭
  float: FloatRect;
  open: boolean;
  tab: ChatTab;
}

export const DOCK_MIN = 280;
export const DOCK_MAX_FRAC = 0.6;
export const FLOAT_MIN_W = 300;
export const FLOAT_MIN_H = 280;
export const SNAP_EDGE = 56; // 끄는 동안 창 가장자리 이 안이면 그쪽 도킹 미리보기
export const DRAG_THRESHOLD = 6;

export const DEFAULT_LAYOUT: ChatLayout = {
  mode: "right",
  width: 400,
  float: { x: -1, y: -1, w: 420, h: 600 }, // x<0 = 아직 안 떼 봄 → 처음 뗄 때 포인터 기준으로 잡는다
  open: false,
  tab: "chat",
};

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

export function clampDockWidth(w: number, vw: number): number {
  return Math.round(clamp(w, DOCK_MIN, Math.floor(vw * DOCK_MAX_FRAC)));
}

/** 창 밖으로 못 나가게 — 크기가 창보다 크면 창에 맞춰 줄인다. */
export function clampFloat(r: FloatRect, vw: number, vh: number): FloatRect {
  const w = Math.round(clamp(r.w, Math.min(FLOAT_MIN_W, vw), vw));
  const h = Math.round(clamp(r.h, Math.min(FLOAT_MIN_H, vh), vh));
  return { w, h, x: Math.round(clamp(r.x, 0, vw - w)), y: Math.round(clamp(r.y, 0, vh - h)) };
}

/** 저장본 → 검증된 배치. 망가진 값은 기본값으로. */
export function sanitizeLayout(raw: unknown, vw: number, vh: number): ChatLayout {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<ChatLayout> & { float?: Partial<FloatRect> };
  const mode: ChatMode = o.mode === "left" || o.mode === "float" ? o.mode : "right";
  const f: Partial<FloatRect> = o.float ?? {};
  const float = { x: num(f.x, -1), y: num(f.y, -1), w: num(f.w, DEFAULT_LAYOUT.float.w), h: num(f.h, DEFAULT_LAYOUT.float.h) };
  return {
    mode,
    width: clampDockWidth(num(o.width, DEFAULT_LAYOUT.width), vw),
    float: float.x < 0 || float.y < 0 ? float : clampFloat(float, vw, vh),
    open: o.open === true,
    tab: o.tab === "summary" ? "summary" : "chat",
  };
}

export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const RESIZE_DIRS: ResizeDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** 플로팅 8방향 리사이즈. 반대편 변은 고정, 최소 크기·창 경계에서 멈춘다. */
export function resizeFloat(start: FloatRect, dir: ResizeDir, dx: number, dy: number, vw: number, vh: number): FloatRect {
  let { x, y, w, h } = start;
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  if (dir.includes("e")) w = clamp(start.w + dx, FLOAT_MIN_W, vw - start.x);
  if (dir.includes("s")) h = clamp(start.h + dy, FLOAT_MIN_H, vh - start.y);
  if (dir.includes("w")) {
    x = clamp(start.x + dx, 0, right - FLOAT_MIN_W);
    w = right - x;
  }
  if (dir.includes("n")) {
    y = clamp(start.y + dy, 0, bottom - FLOAT_MIN_H);
    h = bottom - y;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** 포인터 x 가 창 좌/우 가장자리 안이면 그쪽. */
export function snapSide(clientX: number, vw: number): "left" | "right" | null {
  if (clientX <= SNAP_EDGE) return "left";
  if (clientX >= vw - SNAP_EDGE) return "right";
  return null;
}

/** 도킹 → 플로팅으로 뗄 때 첫 사각형 — 잡은 헤더 지점이 포인터 밑에 그대로 남게. */
export function detachRect(
  prev: FloatRect,
  grab: { x: number; y: number }, // 패널 안에서 잡은 위치(px)
  panel: { w: number; h: number },
  pointer: { x: number; y: number },
  vw: number,
  vh: number,
): FloatRect {
  const w = Math.min(prev.w, Math.max(FLOAT_MIN_W, panel.w));
  const h = prev.x < 0 ? Math.min(prev.h, Math.round(vh * 0.75)) : prev.h;
  // 폭이 줄면 잡은 x 도 비율로 줄인다 — 안 그러면 포인터가 창 밖(오른쪽)에 걸린다.
  const gx = panel.w > 0 ? (grab.x * w) / panel.w : grab.x;
  return clampFloat({ x: pointer.x - gx, y: pointer.y - grab.y, w, h }, vw, vh);
}
