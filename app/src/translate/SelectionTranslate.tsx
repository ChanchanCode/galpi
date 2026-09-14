// 선택 텍스트 번역 — 단축키 중심(자동 팝업 없음).
// 본문에서 텍스트 선택 후 T 키 또는 우클릭 → 팝오버에 번역. 선택 툴바의 번역 버튼은 "galpi:action" 으로 같은 경로를 탄다.
// (선택할 때마다 뜨던 자동 버튼은 사용자 요청으로 제거. §8 형광펜과 선택 충돌 방지)
// 호출은 ai:stream 경유 — 사용량이 원장에 기록되고 Esc/닫기로 실제 취소된다.
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { isEditableTarget, matchCombo } from "../keys/keymap";
import { aiErrorHint } from "../ai/ai";
import { onAction, readSelectionQuote } from "../selection/quote";

interface Anchor {
  x: number;
  y: number;
  text: string;
}

export function SelectionTranslate({
  containerSel,
  docId,
  docTitle,
}: {
  containerSel: string;
  docId?: string;
  docTitle?: string;
}) {
  const translateCombo = useStore((s) => s.keymap.translate);
  const contextTranslate = useStore((s) => s.reading.contextTranslate);
  const provider = useStore((s) => s.ai.provider);
  const providerLabel = provider === "openai" ? "OpenAI" : provider === "anthropic" ? "Claude" : "Gemini";
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const reqRef = useRef(0); // 최신 요청 토큰 — 겹친 스트림의 잔여 델타 무시
  const jobRef = useRef<string | null>(null); // 실행 중 잡 — Esc/닫기로 취소(H6)

  // 현재 선택이 본문 컨테이너 안인지 + 위치/텍스트 반환
  const getSelectionInContainer = useCallback((): Anchor | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString().trim();
    if (text.length < 2) return null;
    const range = sel.getRangeAt(0);
    const container = document.querySelector(containerSel);
    let body = text;
    if (!container || !container.contains(range.commonAncestorContainer)) {
      // 원본 모드 지면 텍스트층(영문)도 원문이다. 쪽을 넘는 선택은 사이의 번역 카드를 가로지르므로
      // 글자는 줄에서만 모은 인용 텍스트를 쓴다(selection/quote).
      const sq = readSelectionQuote(2);
      if (sq?.quote.origin !== "page") return null;
      body = sq.quote.text;
    }
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.bottom, text: body };
  }, [containerSel]);

  const translate = useCallback(
    async (a: Anchor) => {
      const my = ++reqRef.current;
      const prev = jobRef.current;
      if (prev) void window.paperAPI.aiCancel(prev); // 겹친 요청은 앞엣것을 끊는다
      const jobId = window.paperAPI.newJobId();
      jobRef.current = jobId;
      setAnchor(a);
      setLoading(true);
      setResult("");
      try {
        const res = await window.paperAPI.aiStream(
          {
            jobId,
            feature: "translate.selection",
            text: a.text,
            docId,
            docTitle,
            scope: { kind: "selection" },
          },
          (delta) => {
            if (my !== reqRef.current) return; // 더 새 요청이 시작됨 → 무시
            setLoading(false); // 첫 조각 도착 → 스피너 끄고 흘려보냄
            setResult((p) => (p ?? "") + delta);
          },
        );
        if (my !== reqRef.current) return;
        if (res.error) {
          if (res.error.kind === "canceled") setResult(null);
          else {
            const hint = aiErrorHint(res.error.kind);
            setResult(`⚠️ ${res.error.message}${hint ? `\n${hint}` : ""}`);
          }
        } else setResult(res.text ?? "");
      } catch (err) {
        if (my === reqRef.current) setResult(`⚠️ ${String(err)}`);
      } finally {
        if (jobRef.current === jobId) jobRef.current = null;
        if (my === reqRef.current) setLoading(false);
      }
    },
    [docId, docTitle],
  );

  const close = useCallback(() => {
    const job = jobRef.current;
    if (job) void window.paperAPI.aiCancel(job); // 진행 중이면 실제로 끊는다
    jobRef.current = null;
    reqRef.current += 1;
    setAnchor(null);
    setResult(null);
    setLoading(false);
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

  // 선택 툴바(galpi:action "translate") — T 키와 같은 경로
  useEffect(
    () =>
      onAction((a) => {
        if (a.id !== "translate") return;
        const an = getSelectionInContainer();
        if (an) translate(an);
      }),
    [getSelectionInContainer, translate],
  );

  // 우클릭: 선택이 있으면 번역(기본 컨텍스트 메뉴 대신). **기본 꺼짐** —
  // 번역 카드 우클릭 메뉴(재번역)와 부딪히고, 시스템 메뉴도 못 쓰게 된다.
  useEffect(() => {
    if (!contextTranslate) return;
    const onCtx = (e: MouseEvent) => {
      const a = getSelectionInContainer();
      if (a) {
        e.preventDefault();
        translate(a);
      }
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, [getSelectionInContainer, translate, contextTranslate]);

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
          <button className="sel-close" onClick={close}>{loading ? "중단" : "닫기"}</button>
        </div>
      </div>
    </div>
  );
}
