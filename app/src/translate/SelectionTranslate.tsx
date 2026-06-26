// 선택 텍스트 번역 (로컬 NLLB). 본문에서 드래그 선택 → 떠오르는 "번역" 버튼
// 또는 단축키(T)로 번역 → 팝오버 표시. (§8 형광펜 미니툴바와 UX 공유 예정)
import { useCallback, useEffect, useRef, useState } from "react";

interface Anchor {
  x: number;
  y: number;
  text: string;
}

export function SelectionTranslate({ containerSel }: { containerSel: string }) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 현재 선택이 본문 컨테이너 안인지 + 텍스트 반환
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

  // 드래그 선택이 끝나면 앵커(번역 버튼) 표시
  useEffect(() => {
    const onUp = () => {
      const a = getSelectionInContainer();
      if (a) {
        setAnchor(a);
        setResult(null);
      } else if (!boxRef.current?.matches(":hover")) {
        setAnchor(null);
      }
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, [getSelectionInContainer]);

  const doTranslate = useCallback(async (text: string) => {
    setLoading(true);
    setResult(null);
    try {
      const res = await window.paperAPI.translate(text);
      setResult(res.error ? `⚠️ ${res.error}` : res.translation ?? "");
    } finally {
      setLoading(false);
    }
  }, []);

  // 단축키 T: 현재 선택 즉시 번역 / Esc: 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAnchor(null);
        setResult(null);
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.key === "t" || e.key === "T") && !e.metaKey && !e.ctrlKey) {
        const a = getSelectionInContainer();
        if (a) {
          setAnchor(a);
          doTranslate(a.text);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [getSelectionInContainer, doTranslate]);

  if (!anchor) return null;

  // 화면 경계 보정(팝오버가 우측/하단을 벗어나지 않게)
  const left = Math.min(anchor.x, window.innerWidth - 360);
  const top = Math.min(anchor.y + 8, window.innerHeight - 220);

  return (
    <div
      ref={boxRef}
      className="sel-translate"
      style={{ left: Math.max(8, left), top }}
      onMouseDown={(e) => e.preventDefault()} // 선택 유지
    >
      {result === null && !loading && (
        <button className="sel-btn" onClick={() => doTranslate(anchor.text)}>
          번역 (T)
        </button>
      )}
      {(loading || result !== null) && (
        <div className="sel-popover">
          <div className="sel-src">{anchor.text}</div>
          <div className="sel-divider" />
          {loading ? (
            <div className="sel-loading">번역 중… (첫 실행은 모델 로딩으로 느릴 수 있어요)</div>
          ) : (
            <div className="sel-result">{result}</div>
          )}
          <div className="sel-foot">
            <span className="sel-engine">로컬 NLLB · 오프라인</span>
            <button className="sel-close" onClick={() => { setAnchor(null); setResult(null); }}>닫기</button>
          </div>
        </div>
      )}
    </div>
  );
}
