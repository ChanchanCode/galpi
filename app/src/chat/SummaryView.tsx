// 핵심 요약 탭 — 없으면 보는 순간 한 번 만든다. 생성 중엔 글자 없는 스켈레톤.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PaperSummary, SummaryState } from "../../electron/preload";
import { Markdown } from "./Markdown";
import { ERR_LABEL } from "./MessageItem";

export function useSummary(docId: string) {
  const [summary, setSummary] = useState<PaperSummary | null>(null);
  const [state, setState] = useState<SummaryState>("idle");
  const [error, setError] = useState<{ kind: string; message: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const cur = useRef(docId);
  cur.current = docId;

  useEffect(() => {
    let alive = true;
    setSummary(null);
    setState("idle");
    setError(null);
    setLoaded(false);
    Promise.all([window.paperAPI.summaryGet(docId), window.paperAPI.summaryState(docId)])
      .then(([s, st]) => {
        if (!alive) return;
        setSummary(s);
        setState(st === "running" ? "running" : s ? "done" : st);
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    const off = window.paperAPI.onSummaryChanged((e) => {
      if (!alive || e.docId !== docId) return;
      setState(e.state);
      setError(e.error ?? null);
      if (e.state === "done") {
        void window.paperAPI.summaryGet(docId).then((s) => alive && setSummary(s)).catch(() => {});
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [docId]);

  const generate = useCallback(
    (force: boolean) => {
      setState("running");
      setError(null);
      window.paperAPI
        .summaryGenerate(docId, { force })
        .then((r) => {
          if (cur.current !== docId) return;
          if (r.summary) {
            setSummary(r.summary);
            setState("done");
          } else if (r.error) {
            setState("error");
            setError(r.error);
          }
        })
        .catch((e) => {
          if (cur.current !== docId) return;
          setState("error");
          setError({ kind: "network", message: String(e) });
        });
    },
    [docId],
  );

  return useMemo(() => ({ summary, state, error, loaded, generate }), [summary, state, error, loaded, generate]);
}

export type SummaryApi = ReturnType<typeof useSummary>;

const SECTIONS: { key: "question" | "method" | "data"; label: string }[] = [
  { key: "question", label: "연구 질문" },
  { key: "method", label: "방법" },
  { key: "data", label: "데이터" },
];
const LISTS: { key: "findings" | "contributions" | "limitations"; label: string }[] = [
  { key: "findings", label: "핵심 결과" },
  { key: "contributions", label: "기여" },
  { key: "limitations", label: "한계" },
];

const RETRY_ICO = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 4v5h-5" />
  </svg>
);

interface Props {
  docId: string;
  sum: SummaryApi;
  active: boolean;
  onAsk: (q: string) => void;
}

export const SummaryView = memo(function SummaryView({ docId, sum, active, onAsk }: Props) {
  const { summary, state, error, loaded, generate } = sum;
  const tried = useRef(new Set<string>());

  // 보는 순간 자동 생성 — 문서당 한 번. 실패하면 재시도 버튼으로만 다시 부른다(한도·과금 루프 방지).
  useEffect(() => {
    if (!active || !loaded || summary || state === "running" || state === "error") return;
    if (tried.current.has(docId)) return;
    tried.current.add(docId);
    generate(false);
  }, [active, loaded, summary, state, docId, generate]);

  const s = summary;
  const hasFields = !!s && !!(s.tldr || s.question || s.findings?.length);

  return (
    <div className="chat-scroll sum-view">
      {state === "running" && !hasFields ? (
        <div className="sum-skel" aria-busy="true">
          {[92, 100, 78, 0, 40, 96, 88, 0, 36, 100, 84, 70].map((w, i) =>
            w ? <span key={i} className="skel-line" style={{ width: `${w}%` }} /> : <span key={i} className="skel-gap" />,
          )}
        </div>
      ) : state === "error" && !s ? (
        <div className="chat-err sum-err">
          <span title={error?.message}>{ERR_LABEL[error?.kind ?? ""] ?? "오류"}</span>
          <button className="chat-ico" onClick={() => generate(true)} title="다시 시도" aria-label="다시 시도">{RETRY_ICO}</button>
        </div>
      ) : s && !hasFields && s.raw ? (
        <Markdown text={s.raw} className="sum-raw" />
      ) : s ? (
        <div className={`sum-body ${state === "running" ? "stale" : ""}`}>
          {s.tldr && <Markdown text={s.tldr} className="sum-tldr" />}
          {!!s.keywords?.length && (
            <div className="sum-kw">
              {s.keywords.map((k, i) => (
                <span key={i} className="sum-chip">{k}</span>
              ))}
            </div>
          )}
          {SECTIONS.map(({ key, label }) =>
            s[key] ? (
              <section key={key} className="sum-sec">
                <h4>{label}</h4>
                <Markdown text={s[key] as string} />
              </section>
            ) : null,
          )}
          {LISTS.map(({ key, label }) =>
            s[key]?.length ? (
              <section key={key} className="sum-sec">
                <h4>{label}</h4>
                <ul className="sum-list">
                  {s[key].map((t, i) => (
                    <li key={i}>
                      <Markdown text={t} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null,
          )}
          {!!s.questions?.length && (
            <section className="sum-sec">
              <h4>질문</h4>
              <div className="chat-suggest">
                {s.questions.map((q, i) => (
                  <button key={i} className="chat-chip-q" onClick={() => onAsk(q)}>{q}</button>
                ))}
              </div>
            </section>
          )}
          {error && state === "error" && (
            <div className="chat-err">
              <span title={error.message}>{ERR_LABEL[error.kind] ?? "오류"}</span>
              <button className="chat-ico" onClick={() => generate(true)} title="다시 시도" aria-label="다시 시도">{RETRY_ICO}</button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
});
