// 번역 시작 팝업 — 상단바 `T` 아래.
//
// **처음 번역할 때만** 뜬다. 이미 번역된 문서에서 T 는 그냥 번역 컬럼을 켜고 끈다.
// 재번역은 카드 우클릭 메뉴에서 한다.
// 문구는 라벨·숫자·버튼만. 설명 문장은 넣지 않는다.
import { useEffect, useRef, useState } from "react";
import type { AIStatus, TranslatePlan, TranslateProgress } from "../../electron/preload";

// §2.2 실측 — 한도 소모는 요청 수가 아니라 **토큰 비용**에 비례한다(thinking 은 출력으로 계산).
const IN_COST = 3.306e-8;
const OUT_COST = 3.795e-7;

export function quotaPct(u: { in: number; out: number; think?: number }): number {
  return (u.in * IN_COST + (u.out + (u.think ?? 0)) * OUT_COST) * 100;
}

function pct(n: number): string {
  return n >= 1 ? `${n.toFixed(1)}%` : `${n.toFixed(2)}%`;
}

const ERR_LABEL: Record<string, string> = {
  auth: "로그인 필요",
  rate_limit: "한도 도달",
  breaker: "차단됨",
  network: "연결 실패",
  server: "서버 오류",
  parse: "응답 오류",
  config: "설정 필요",
};

// 번역 모델은 agy 모델 목록에서 **정확한 이름**으로 고른다(사용자 요청 — "빠름/정확" 은 무엇인지 알 수 없다).
// D5 — 기본은 gemini-3.7-flash-low. 모델을 바꾸면 번역 캐시 키가 달라져 기존 번역은 다시 돈다.
interface Props {
  anchor: React.RefObject<HTMLElement>;
  plan: TranslatePlan | null;
  progress: TranslateProgress | null;
  running: boolean;
  onStart: () => void;
  onCancel: () => void;
  onClose: () => void;
}

export function TranslatePopover({ anchor, plan, progress, running, onStart, onCancel, onClose }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<AIStatus | null>(null);
  const [model, setModel] = useState<string>("");
  const [agyModels, setAgyModels] = useState<{ id: string; label: string }[]>([]);
  const [right, setRight] = useState(18);

  // 어느 AI 에 붙어 있는지 — agy(구독)인지 내 API 키인지. 무과금 조회다.
  useEffect(() => {
    let alive = true;
    void window.paperAPI
      .aiStatus()
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        setModel(s.model);
      })
      .catch(() => {});
    void window.paperAPI
      .chatModels()
      .then((l) => {
        if (!alive) return;
        setAgyModels(l.models.filter((m) => m.group === "agy").map((m) => ({ id: m.id.replace(/^agy:/, ""), label: m.label })));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = anchor.current;
    if (!el) return;
    setRight(Math.max(12, window.innerWidth - el.getBoundingClientRect().right));
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current?.contains(e.target as Node)) return;
      if (anchor.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  const agy = status?.backend.id === "agy";
  const rawErr = progress?.error;
  const err = rawErr && rawErr.kind !== "canceled" ? rawErr : null;
  const pending = plan?.pending ?? 0;

  const pick = (id: string) => {
    setModel(id);
    void window.paperAPI.agySetModel(id);
  };

  return (
    <div className="tr-pop" ref={boxRef} style={{ right }}>
      <div className="tr-pop-row tr-pop-head">
        <span>{agy ? "Antigravity 구독" : "API 키"}</span>
        {!agy && <span className="tr-pop-model">{status?.provider ?? ""}</span>}
      </div>

      {running ? (
        <>
          <div className="tr-pop-row">
            <span className="tr-pop-k">진행</span>
            <span className="tr-pop-v">
              {(progress?.done ?? 0) + (progress?.cached ?? 0)} / {progress?.total ?? plan?.total ?? 0}
            </span>
          </div>
          {agy && progress && (
            <div className="tr-pop-row">
              <span className="tr-pop-k">소모</span>
              <span className="tr-pop-v">
                {pct(quotaPct(progress.usage))}{" "}
                <em>/ {pct(quotaPct({ in: progress.est.in, out: progress.est.out }))}</em>
              </span>
            </div>
          )}
          <div className="tr-pop-actions">
            <button className="tr-pop-btn" onClick={onCancel}>중단</button>
          </div>
        </>
      ) : (
        <>
          {err && <div className="tr-pop-row tr-pop-err" title={err.message}>{ERR_LABEL[err.kind] ?? "오류"}</div>}
          {agy && (
            <div className="tr-pop-row">
              <span className="tr-pop-k">모델</span>
              <select className="tr-pop-select" value={model} onChange={(e) => pick(e.target.value)} title={model}>
                {model && !agyModels.some((m) => m.id === model) && <option value={model}>{model}</option>}
                {agyModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          )}
          <div className="tr-pop-row">
            <span className="tr-pop-k">분량</span>
            <span className="tr-pop-v">
              {pending} 블록
              {agy && plan && <em> · 약 {pct(quotaPct({ in: plan.est.in, out: plan.est.out }))}</em>}
            </span>
          </div>
          <div className="tr-pop-actions">
            <button className="tr-pop-btn ghost" onClick={onClose}>취소</button>
            <button className="tr-pop-btn on" onClick={onStart} disabled={pending === 0}>번역</button>
          </div>
        </>
      )}
    </div>
  );
}
