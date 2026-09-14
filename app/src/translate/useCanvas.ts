// 팬/줌 캔버스 — 보기 A·B 가 **같은 코드**를 쓴다 (PLAN-AI D11·D12).
//
// 줌이 이 파일에서 가장 조심스러운 부분이다 (D12):
//   · 제스처 중에는 `transform: scale()` 로 부드럽게 미리 보여주고,
//   · 손을 뗀 뒤 `.src-doc` 의 transform: scale 로 확정한다 — **will-change 가 없으면** Chromium 이
//     멈춘 배율로 다시 래스터해 선명하다(2026-09-13 실측, 2.5배 확인). 예전에는 CSS `zoom` 으로 확정했는데
//     그건 확정마다 전체 레이아웃+페인트(11k 노드, 0.2~0.3초 × 2프레임)라 확대할 때마다 끊겼다(사용자 신고).
//     transform 은 레이아웃이 없으니, 스크롤 높이만 부모(.src-shift) 높이로 따로 맞춰 준다(syncHeight).
//   · `will-change: transform` 은 금지. GPU 레이어로 승격되면 승격 시점 해상도로 한 번만
//     래스터화되고 이후 scale() 이 그 비트맵을 늘려 SVG 든 한글이든 전부 뭉갠다.
//
// 세로는 `.reader-scroll` 의 네이티브 스크롤을 그대로 쓴다(연속 스크롤).
// 가로만 transform 이동이다 — 지면을 화면 밖까지 끌 수 있어야 확대 상태에서 가장자리를 본다.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export const MIN_Z = 0.4;
export const MAX_Z = 6;
// 확정(zoom → 전체 레이아웃)은 한 번에 0.1~0.3초 걸린다(실측 11k 노드). 제스처 도중에 확정이 끼면
// 그 사이 휠 이벤트가 밀려 다시 확정이 걸리는 식으로 연쇄 끊김이 났다(실측: 한 번 핀치에 4회) —
// 손을 뗀 게 확실할 때 한 번만 확정한다.
const COMMIT_MS = 360;
const ZOOM_HUD_MS = 1500; // 배율 표시가 떠 있는 시간

/** 확정 배율을 거는 스타일 — App(보기 A)·SourceView(보기 B) 공용. */
export function docScaleStyle(z: number): React.CSSProperties {
  return z === 1 ? {} : { transform: `scale(${z})`, transformOrigin: "0 0" };
}
const WHEEL_SENS = 0.0022; // 마우스 휠 (한 칸 100~120)
const PINCH_SENS = 0.012; // 트랙패드 핀치 (1~10 단위로 잘게 온다)
const PINCH_DELTA_MAX = 25;

// 화면 밖으로 얼마나 끌 수 있는가 — 캔버스 폭의 12%.
// 0.6 은 "제한이 없다"고 느껴졌다(사용자 신고). 콘텐츠가 화면에 딱 맞을 때는
// 거의 안 움직이고, 확대해서 넘칠 때만 그 넘친 만큼 움직이는 게 맞다.
const SLACK = 0.12;

// 호출자가 넘기는 선택자와 무관하게 **늘 선택으로 남기는** 곳 — 원본 지면 텍스트층의 줄(에이전트 F).
// App 이 넘기는 skipPanSel 에 빠져 있어도 지면 글자 위 드래그가 패닝에 먹히지 않게 한다.
const ALWAYS_SELECT = ".src-tl-line";

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

function clampPan(x: number, canvasW: number, contentW: number): number {
  const slack = canvasW * SLACK;
  return clamp(x, Math.min(0, canvasW - contentW) - slack, Math.max(0, canvasW - contentW) + slack);
}

export interface Canvas {
  /** 사용자가 직접 확대·이동한 적이 있는가. 있으면 자동 맞춤이 그걸 덮지 않는다. */
  touched: boolean;
  /** 배율 표시를 띄울 때만 true — 방금 확대·축소한 1.5초 동안만. */
  zoomVisible: boolean;
  /** 확정 배율. `docStyle(z)` 로 `.src-doc` 에 transform 으로 건다. */
  z: number;
  /** 가로 이동을 거는 래퍼. **transform 을 직접 쓴다** — state 로 두면 프레임마다
   *  카드 수백 개가 리렌더돼 가로 이동만 버벅인다(세로는 네이티브 스크롤이라 멀쩡했다). */
  shiftRef: React.RefObject<HTMLDivElement>;
  /** 캔버스 기준 폭 — `zoom` 은 % 가 아니라 px 이어야 커진다. */
  baseW: number;
  canvasRef: React.RefObject<HTMLDivElement>;
  panRef: React.RefObject<HTMLDivElement>;
  onPointerDown: (e: React.PointerEvent) => void;
  zoomBy: (f: number, ax?: number, ay?: number) => void;
  /** 주어진 콘텐츠 폭이 화면에 다 들어오도록 축소한다. 이미 들어오면 아무것도 안 한다. */
  fit: (contentWidth: number) => void;
  reset: () => void;
}

/**
 * `skipPanSel` 안에서 시작한 드래그는 패닝이 아니라 텍스트 선택으로 둔다.
 * `docWidth` 는 실제 콘텐츠 폭(무확대 기준). 안 주면 캔버스 폭을 쓴다 —
 * 번역 컬럼을 넓혀 콘텐츠가 캔버스보다 넓어지면 이 값이 있어야 끝까지 밀린다.
 */
export function useCanvas(active: boolean, skipPanSel: string, docWidth?: number): Canvas {
  const canvasRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<HTMLDivElement>(null);
  const shiftRef = useRef<HTMLDivElement>(null);
  const [baseW, setBaseW] = useState(0);
  const [z, setZ] = useState(1);
  const gest = useRef({ k: 1, ax: 0, ay: 0, timer: 0 as ReturnType<typeof setTimeout> | number });
  const pending = useRef<{ ax: number; ay: number; k: number } | null>(null);
  const spaceRef = useRef(false);
  const [zoomVisible, setZoomVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 사용자가 한 번이라도 직접 만졌으면 자동 맞춤이 그 배율을 덮으면 안 된다.
  const touchedRef = useRef(false);
  // 드래그 클로저는 한 번만 만들어지므로 최신 값을 ref 로 본다.
  const panXRef = useRef(0);
  const docWRef = useRef(0);
  const zRef = useRef(1);
  docWRef.current = Math.max(docWidth || 0, baseW);
  zRef.current = z;

  // 가로 이동은 DOM 에 직접 쓴다. rAF 로 프레임당 한 번만 반영해 레이아웃 스래싱을 막는다.
  const rafRef = useRef(0);
  const flushPan = useCallback(() => {
    rafRef.current = 0;
    const el = shiftRef.current;
    if (el) el.style.transform = panXRef.current ? `translateX(${panXRef.current}px)` : "";
  }, []);
  const setPan = useCallback(
    (next: number | ((prev: number) => number)) => {
      const v = typeof next === "function" ? (next as (p: number) => number)(panXRef.current) : next;
      if (v === panXRef.current) return;
      panXRef.current = v;
      if (!rafRef.current) rafRef.current = requestAnimationFrame(flushPan);
    },
    [flushPan],
  );
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // 이동은 DOM 에 직접 쓰므로 노드가 새로 만들어지면(보기 전환 → 재마운트) 값이 사라진다.
  // 렌더 뒤마다 다시 붙여 준다 — style 대입 한 번이라 비용은 없다.
  useLayoutEffect(() => {
    const el = shiftRef.current;
    if (el) el.style.transform = panXRef.current ? `translateX(${panXRef.current}px)` : "";
  });

  const scroller = () => document.querySelector(".reader-scroll") as HTMLElement | null;

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => setBaseW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);

  // transform 은 레이아웃 크기를 안 바꾼다 — 캔버스가 overflow:hidden 이라 그대로 두면 확대해도 스크롤이
  // 원래 높이에서 끝난다. 확정 배율만큼 부모 높이를 직접 준다. 문서 높이가 바뀌면(번역 여백·추출 이어짐) 다시.
  const syncHeight = useCallback(() => {
    const shift = shiftRef.current;
    const doc = shift?.firstElementChild as HTMLElement | null;
    if (!shift || !doc) return;
    const want = zRef.current === 1 ? "" : `${Math.ceil(doc.offsetHeight * zRef.current)}px`;
    if (shift.style.height !== want) shift.style.height = want;
  }, []);
  useEffect(() => {
    const doc = shiftRef.current?.firstElementChild as HTMLElement | null;
    if (!active || !doc) return;
    const ro = new ResizeObserver(syncHeight);
    ro.observe(doc);
    return () => ro.disconnect();
  }, [active, syncHeight]);

  // 창 크기·배율이 바뀌면 지금 위치가 허용 범위 밖일 수 있다 → 다시 자른다.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !baseW) return;
    setPan((x) => clampPan(x, canvas.clientWidth, docWRef.current * z));
  }, [baseW, z, docWidth, setPan]);

  const applyPreview = useCallback(() => {
    const pan = panRef.current;
    const sc = scroller();
    if (!pan || !sc) return;
    const { k, ax, ay } = gest.current;
    // 가로는 panX 가 안쪽 래퍼에 이미 걸려 있으므로 여기서는 앵커 보정만 한다.
    const tx = (1 - k) * ax;
    const ty = (1 - k) * (ay + sc.scrollTop);
    pan.style.transform = k === 1 ? "" : `translate(${tx}px, ${ty}px) scale(${k})`;
  }, []);

  const commit = useCallback(() => {
    const { k, ax, ay } = gest.current;
    if (k === 1) return;
    pending.current = { ax, ay, k };
    setZ((prev) => clamp(prev * k, MIN_Z, MAX_Z));
    gest.current.k = 1;
  }, []);

  // 배율이 확정된 **뒤에** 위치를 옮겨야 커서 아래 지점이 제자리에 남는다.
  // 높이를 먼저 맞춰야 한다 — 안 그러면 늘어난 scrollTop 이 옛 높이에 잘린다.
  useLayoutEffect(() => {
    const a = pending.current;
    pending.current = null;
    const pan = panRef.current;
    const canvas = canvasRef.current;
    const sc = scroller();
    if (pan) pan.style.transform = "";
    syncHeight();
    if (!a || !canvas || !sc) return;
    // q0 = (ax - panX)/Z  →  panX' = ax - q0·Z'
    setPan((x) => clampPan(a.ax - (a.ax - x) * a.k, canvas.clientWidth, docWRef.current * zRef.current));
    sc.scrollTop = (a.ay + sc.scrollTop) * a.k - a.ay;
  }, [z, syncHeight]);

  const zoomBy = useCallback(
    (f: number, ax?: number, ay?: number) => {
      const canvas = canvasRef.current;
      const sc = scroller();
      if (!canvas || !sc) return;
      const g = gest.current;
      if (g.k === 1) {
        // 인자가 없으면(버튼) 화면 한가운데를 기준으로.
        g.ax = ax ?? canvas.clientWidth / 2;
        g.ay = ay ?? sc.clientHeight / 2;
      }
      touchedRef.current = true;
      g.k = clamp(g.k * f, MIN_Z / zRef.current, MAX_Z / zRef.current);
      applyPreview();
      // 배율 표시는 방금 만진 동안만 — 평소 읽을 때 화면에 뜬 UI 를 늘리지 않는다.
      setZoomVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setZoomVisible(false), ZOOM_HUD_MS);
      clearTimeout(g.timer as ReturnType<typeof setTimeout>);
      g.timer = setTimeout(commit, COMMIT_MS);
    },
    [applyPreview, commit],
  );

  // 콘텐츠가 캔버스보다 넓으면 그만큼 줄여 한 화면에 담는다.
  // 번역 컬럼을 열었을 때 컬럼이 화면 밖으로 잘리는 것을 막는다.
  const fit = useCallback(
    (contentWidth: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !contentWidth) return;
      // **직접 확대·이동한 뒤에는 절대 덮지 않는다.** 버튼 하나 눌렀다고 배율이 날아가면 안 된다.
      if (touchedRef.current) return;
      const cw = canvas.clientWidth;
      if (contentWidth <= cw) return;
      gest.current.k = 1;
      pending.current = null;
      setZ(clamp(cw / contentWidth, MIN_Z, 1));
      setPan(0);
    },
    [setPan],
  );

  const reset = useCallback(() => {
    gest.current.k = 1;
    pending.current = null;
    setZ(1);
    setPan(0);
    touchedRef.current = false;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setZoomVisible(false);
  }, [setPan]);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  // 트랙패드 핀치는 Chromium 에서 ctrlKey 가 붙은 wheel 로 온다.
  useEffect(() => {
    const canvas = canvasRef.current;
    const sc = scroller();
    if (!active || !canvas || !sc) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const rs = sc.getBoundingClientRect();
      // 트랙패드 핀치와 마우스 휠은 둘 다 ctrlKey wheel 로 오지만 알갱이가 다르다.
      // 휠은 한 칸에 100~120, 핀치는 1~10 단위로 잘게 온다. 같은 계수를 쓰면 핀치가 뻑뻑하다.
      const pinch = Math.abs(e.deltaY) < PINCH_DELTA_MAX;
      const k = pinch ? PINCH_SENS : WHEEL_SENS;
      zoomBy(Math.exp(-e.deltaY * k), e.clientX - r.left, e.clientY - rs.top);
    };
    // 두 손가락 가로 밀기 → 가로 이동. 세로는 네이티브 스크롤 그대로 둔다.
    const onPan = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      touchedRef.current = true;
      setPan((x) => clampPan(x - e.deltaX, canvas.clientWidth, docWRef.current * zRef.current));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("wheel", onPan, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("wheel", onPan);
    };
  }, [active, zoomBy, setPan]);

  // ⌘0 맞춤 / Space 패닝
  useEffect(() => {
    if (!active) return;
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        // Space 는 패닝 수식키다. 기본 동작(한 화면 스크롤)을 막지 않으면 꾹 누르는 동안
        // 화면이 계속 내려가 포커스 모드에서 '다음 문장'이 폭주한다.
        // 입력칸·버튼 위에서는 그대로 둔다(타이핑·버튼 활성화).
        // 버튼은 일부러 제외하지 않는다 — 상단바 버튼에 포커스가 남아 있으면 Space 가
        // 그 버튼을 눌러 버린다(사용자 신고). 버튼 활성화는 Enter 로 한다.
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName ?? "";
        const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!t?.isContentEditable;
        if (!typing) {
          e.preventDefault();
          if (!e.repeat) spaceRef.current = true;
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.code === "Digit0") {
        e.preventDefault();
        reset();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [active, reset]);

  // 빈 곳/지면 드래그 · 가운데 버튼 · Space+드래그
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const t = e.target as HTMLElement;
      if (e.button !== 0 && e.button !== 1) return;
      // 글자 위에서 시작한 드래그는 선택이다. Space 나 가운데 버튼이면 그래도 패닝.
      if (!spaceRef.current && e.button !== 1 && (t.closest(skipPanSel) || t.closest(ALWAYS_SELECT))) return;
      // ⌥+드래그는 영역 캡처(RegionCapture)다 — 캡처 컴포넌트가 없을 때도 패닝으로 새지 않게.
      if (e.altKey && e.button === 0) return;
      const canvas = canvasRef.current;
      const sc = scroller();
      if (!canvas || !sc) return;
      // 본문을 만지면 버튼 포커스를 놓는다 — 안 그러면 Space·Enter 가 그 버튼으로 샌다.
      const act = document.activeElement as HTMLElement | null;
      if (act && act !== document.body && !act.closest(".tr-pop, .tr-menu, .modal-backdrop")) act.blur();
      e.preventDefault();
      const sx = e.clientX;
      const sy = e.clientY;
      const x0 = panXRef.current;
      const t0 = sc.scrollTop;
      const cw = canvas.clientWidth;
      const contentW = docWRef.current * zRef.current;
      const move = (ev: PointerEvent) => {
        touchedRef.current = true;
        setPan(clampPan(x0 + (ev.clientX - sx), cw, contentW));
        sc.scrollTop = t0 - (ev.clientY - sy);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.classList.remove("src-panning");
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      document.body.classList.add("src-panning");
    },
    [skipPanSel, setPan],
  );

  return { z, baseW, zoomVisible, touched: touchedRef.current, canvasRef, panRef, shiftRef, onPointerDown, zoomBy, fit, reset };
}
