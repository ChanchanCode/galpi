// 메시지 한 개 — user 는 옅은 블록(인용·썸네일 위), assistant 는 전폭 Markdown + hover 푸터.
import { memo, useState } from "react";
import type { ChatMessage, ChatModelInfo } from "../../electron/preload";
import { Markdown } from "./Markdown";

export const ERR_LABEL: Record<string, string> = {
  auth: "로그인 필요",
  rate_limit: "한도 도달",
  breaker: "차단됨",
  network: "연결 실패",
  server: "서버 오류",
  parse: "응답 오류",
  config: "설정 필요",
  timeout: "시간 초과",
};

/** 1234 → 1.2k · 45678 → 46k · 1.2M */
export function fmtK(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** 모델 id → 짧은 표시명. 목록에 있으면 그 label, 없으면 접두사(agy:·rest:<p>:)를 뗀 id. */
export function modelLabel(id: string | undefined, models: ChatModelInfo[]): string {
  if (!id) return "";
  return models.find((m) => m.id === id)?.label ?? id.replace(/^agy:/, "").replace(/^rest:[^:]+:/, "");
}

export const ICO = {
  width: 15, height: 15, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const, "aria-hidden": true,
};

export const CopyIcon = () => (
  <svg {...ICO}><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></svg>
);
export const CheckIcon = () => <svg {...ICO}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
export const RetryIcon = () => (
  <svg {...ICO}><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" /></svg>
);

interface Props {
  msg: ChatMessage;
  docId: string;
  models: ChatModelInfo[];
  streaming: boolean;
  isLast: boolean;
  busy: boolean;
  onRegenerate: () => void;
  onRetry: (id: string) => void;
  onZoom: (url: string) => void;
}

export const MessageItem = memo(function MessageItem({ msg, docId, models, streaming, isLast, busy, onRegenerate, onRetry, onZoom }: Props) {
  const [copied, setCopied] = useState(false);

  if (msg.role === "user") {
    return (
      <div className="chat-msg user">
        {!!msg.quotes?.length && (
          <div className="chat-quotes">
            {msg.quotes.map((q, i) => (
              <div key={i} className="chat-quote" title={q.text.slice(0, 600)}>{q.text}</div>
            ))}
          </div>
        )}
        {!!msg.attachments?.length && (
          <div className="chat-thumbs">
            {msg.attachments.map((a) => {
              const url = window.paperAPI.assetUrl(docId, a.file);
              return (
                <button key={a.id} className="chat-thumb" onClick={() => onZoom(url)} aria-label={a.name ?? "이미지"}>
                  <img src={url} alt="" draggable={false} />
                </button>
              );
            })}
          </div>
        )}
        {msg.text && <div className="chat-user-text">{msg.text}</div>}
      </div>
    );
  }

  const err = msg.status === "error" ? msg.error ?? { kind: "server", message: "" } : null;
  const u = msg.usage;
  const copy = () => {
    void navigator.clipboard.writeText(msg.text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  return (
    <div className={`chat-msg assistant ${streaming ? "streaming" : ""}`}>
      {(msg.text || streaming) && <Markdown text={msg.text} streaming={streaming} />}
      {err && (
        <div className="chat-err">
          <span title={err.message}>{ERR_LABEL[err.kind] ?? "오류"}</span>
          {isLast && (
            <button className="chat-ico" onClick={() => onRetry(msg.id)} disabled={busy} title="다시 시도" aria-label="다시 시도">
              <RetryIcon />
            </button>
          )}
        </div>
      )}
      {!streaming && (
        <div className="chat-foot">
          {msg.model && <span className="chat-foot-model">{modelLabel(msg.model, models)}</span>}
          {u && (u.in > 0 || u.out > 0) && (
            <span title={`in ${u.in} · out ${u.out}${u.think ? ` · think ${u.think}` : ""}`}>
              {fmtK(u.in)}→{fmtK(u.out + (u.think ?? 0))}
            </span>
          )}
          {msg.ms != null && msg.ms > 0 && <span>{(msg.ms / 1000).toFixed(1)}s</span>}
          {msg.status === "canceled" && <span>중단</span>}
          <span className="chat-foot-gap" />
          {msg.text && (
            <button className="chat-ico" onClick={copy} title="복사" aria-label="복사">
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
          )}
          {isLast && !err && (
            <button className="chat-ico" onClick={onRegenerate} disabled={busy} title="다시 생성" aria-label="다시 생성">
              <RetryIcon />
            </button>
          )}
        </div>
      )}
    </div>
  );
});
