// 선택 텍스트 번역 (로컬 NLLB) — 단축키 전용(자동 팝업 없음).
// 본문에서 텍스트 선택 후 T 키 또는 우클릭 → 팝오버에 번역.
// (선택할 때마다 뜨던 자동 버튼은 사용자 요청으로 제거. §8 형광펜과 선택 충돌 방지)
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { isEditableTarget, matchCombo } from "../keys/keymap";

interface Anchor {
  x: number;
  y: number;
  text: string;
}

export function SelectionTranslate({ containerSel }: { containerSel: string }) {
  const translateCombo = useStore((s) => s.keymap.translate);
  const provider = useStore((s) => s.ai.provider);
  const providerLabel = provider === "openai" ? "OpenAI" : provider === "anthropic" ? "Claude" : "Gemini";
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const reqRef = useRef(0); // 최신 요청 토큰 — 겹친 스트림의 잔여 델타 무시

  // 현재 선택이 본문 컨테이너 안인지 + 위치/텍스트 반환
  const getSelectionInContainer = useCallback((): Anchor | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString().trim();
    if (text.length < 2) return null;
    const range = sel.getRangeAt(0);
    const container = document.querySelector(containerSel);
    if (!container || !container.contains(range.commonAncestorContainer)) return null;
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.bottom, text };
  }, [containerSel]);

  const translate = useCallback(async (a: Anchor) => {
    const my = ++reqRef.current;
    setAnchor(a);
    setLoading(true);
    setResult("");
    try {
      const res = await window.paperAPI.translateStream(a.text, (delta) => {
        if (my !== reqRef.current) return; // 더 새 요청이 시작됨 → 무시
        setLoading(false); // 첫 조각 도착 → 스피너 끄고 흘려보냄
        setResult((prev) => (prev ?? "") + delta);
      });
      if (my !== reqRef.current) return;
      if (res.error) setResult(`⚠️ ${res.error}`);
      else setResult(res.translation ?? "");
    } catch (err) {
      if (my === reqRef.current) setResult(`⚠️ ${String(err)}`);
    } finally {
      if (my === reqRef.current) setLoading(false);
    }
  }, []);

  const close = useCallback(() => {
    setAnchor(null);
    setResult(null);
  }, []);

  // 단축키(기본 T): 현재 선택 번역 / Esc: 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return close();
      if (isEditableTarget(e.target)) return;
      if (matchCombo(e, translateCombo)) {
        const a = getSelectionInContainer();
        if (a) {
          e.preventDefault();
          translate(a);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [getSelectionInContainer, translate, close, translateCombo]);

  // 우클릭: 선택이 있으면 번역(기본 컨텍스트 메뉴 대신)
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const a = getSelectionInContainer();
      if (a) {
        e.preventDefault();
        translate(a);
      }
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, [getSelectionInContainer, translate]);

  // 바깥 클릭 시 닫기 (팝오버 내부 클릭은 유지)
  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [anchor, close]);

  if (!anchor) return null;

  // 화면 경계 보정
  const left = Math.min(anchor.x, window.innerWidth - 360);
  const top = Math.min(anchor.y + 8, window.innerHeight - 220);

  return (
    <div
      ref={boxRef}
      className="sel-translate"
      style={{ left: Math.max(8, left), top }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="sel-popover">
        <div className="sel-src">{anchor.text}</div>
        <div className="sel-divider" />
        {loading ? (
          <div className="sel-loading">번역 중…</div>
        ) : (
          <div className="sel-result">{result}</div>
        )}
        <div className="sel-foot">
          <span className="sel-engine">{providerLabel} · 클라우드</span>
          <button className="sel-close" onClick={close}>닫기</button>
        </div>
      </div>
    </div>
  );
}
