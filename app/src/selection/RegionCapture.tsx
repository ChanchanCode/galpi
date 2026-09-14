// 화면 영역 캡처 → 채팅 첨부 (SPEC §4.7). 두 가지로 시작한다:
//  · 채팅 입력창 `+` 메뉴가 쏘는 "galpi:capture-start" → 십자 커서로 대기, 끌어서 사각형
//  · 리더 안에서 ⌥+드래그 → 바로 사각형 (창 capture 단계에서 가로채 캔버스 패닝·텍스트 선택보다 먼저)
// 놓으면 사각형을 치우고 **두 프레임 뒤** main 의 capturePage 로 찍는다 — 오버레이가 사진에 찍히지 않게.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { emitChat } from "../chat/chatBus";
import "./selection.css";

const MIN = 8; // 이보다 작으면 실수로 보고 취소

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const raf2 = () => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));

export function RegionCapture({ docId }: { docId: string }) {
  const [mode, setMode] = useState<"armed" | "drag" | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const docRef = useRef(docId);
  docRef.current = docId;
  const busy = useRef(false);
  // 진행 중 드래그의 창 리스너 — 취소·언마운트에서 반드시 뗀다.
  const detach = useRef<(() => void) | null>(null);

  useEffect(() => {
    const clampX = (v: number) => Math.min(Math.max(v, 0), window.innerWidth);
    const clampY = (v: number) => Math.min(Math.max(v, 0), window.innerHeight);

    const end = () => {
      detach.current?.();
      detach.current = null;
      document.body.classList.remove("rc-active");
      setMode(null);
      setRect(null);
    };

    const shoot = async (r: Rect) => {
      const id = docRef.current;
      busy.current = true;
      try {
        // 선택 하이라이트가 사진에 끼지 않게 치운다.
        window.getSelection()?.removeAllRanges();
        await raf2();
        // 사각형 가운데가 지면·블록 위면 출처로 남긴다(원본 지면 크롭이면 page, 리플로우 블록이면 blockId+page).
        const hit = document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2);
        const pageEl = hit?.closest<HTMLElement>("[data-page]");
        const page = pageEl ? Number(pageEl.dataset.page) : NaN;
        const blockId = hit?.closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
        const source: { page?: number; blockId?: string } = {};
        if (Number.isFinite(page) && page > 0) source.page = page;
        if (blockId && !blockId.startsWith("fn-")) source.blockId = blockId;
        const res = await window.paperAPI.chatCapture(
          id,
          { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) },
          source.page != null || source.blockId ? source : undefined,
        );
        if ("error" in res) console.warn("[capture]", res.error);
        else emitChat({ type: "attach", attachment: res });
      } catch (err) {
        console.warn("[capture]", err);
      } finally {
        busy.current = false;
      }
    };

    const begin = (x0: number, y0: number) => {
      detach.current?.();
      document.body.classList.add("rc-active");
      setMode("drag");
      setRect({ x: x0, y: y0, w: 0, h: 0 });
      let cur: Rect = { x: x0, y: y0, w: 0, h: 0 };
      const move = (e: PointerEvent) => {
        const x1 = clampX(e.clientX);
        const y1 = clampY(e.clientY);
        cur = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
        setRect(cur);
      };
      const up = (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation(); // 선택 툴바·캔버스가 이 손 뗌을 자기 것으로 보지 않게
        move(e);
        // 레이어는 state 반영을 기다리지 않고 바로 숨긴다 — 두 프레임 뒤 사진에 확실히 없게.
        if (layerRef.current) layerRef.current.style.display = "none";
        end();
        if (cur.w < MIN || cur.h < MIN) return;
        void shoot(cur);
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      detach.current = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
      };
    };

    // ⌥+드래그 — 리더 본문 안에서만(채팅 패널 제외). 창 capture 에서 먼저 가로챈다.
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !e.altKey || busy.current || detach.current) return;
      const t = e.target instanceof Element ? e.target : null;
      if (!t || !t.closest(".reader-body") || t.closest(".chat-panel")) return;
      e.preventDefault();
      e.stopPropagation();
      begin(clampX(e.clientX), clampY(e.clientY));
    };

    const onStart = () => {
      if (busy.current || detach.current) return;
      document.body.classList.add("rc-active");
      setMode("armed");
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !document.body.classList.contains("rc-active")) return;
      e.preventDefault();
      e.stopPropagation();
      end();
    };

    // 대기 레이어에서 누르면 시작. React 합성 이벤트 대신 네이티브로 — begin 과 같은 클로저를 쓴다.
    const onLayerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.classList.contains("rc-layer")) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.button !== 0) return end(); // 우클릭 = 취소
      begin(clampX(e.clientX), clampY(e.clientY));
    };

    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerdown", onLayerDown, true);
    window.addEventListener("galpi:capture-start", onStart);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerdown", onLayerDown, true);
      window.removeEventListener("galpi:capture-start", onStart);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", end);
      detach.current?.();
      detach.current = null;
      document.body.classList.remove("rc-active");
    };
  }, []);

  // 문서를 바꾸면 진행 중 캡처는 버린다.
  useEffect(() => {
    detach.current?.();
    detach.current = null;
    document.body.classList.remove("rc-active");
    setMode(null);
    setRect(null);
  }, [docId]);

  if (!mode) return null;
  return createPortal(
    <div ref={layerRef} className="rc-layer" onContextMenu={(e) => e.preventDefault()}>
      {rect && rect.w + rect.h > 0 && (
        <div className="rc-rect" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />
      )}
    </div>,
    document.body,
  );
}
