// 입력창 — 인용 칩 · 첨부 썸네일 · 자동높이 textarea · 하단 줄(+ 메뉴 · 문맥 칩 · 모델 · 전송/중단).
import { parsePaperUrl } from "../selection/quote";
import { useEffect, useRef, useState } from "react";
import type { ChatApi } from "./useChat";
import type { ChatContextMode } from "../../electron/preload";
import { attachmentFromAsset } from "./chatBus";
import { ModelPicker } from "./ModelPicker";
import { ICO, fmtK } from "./MessageItem";

const QUOTE_MIME = "application/x-galpi-quote";
const ATTACH_MIME = "application/x-galpi-attach";

/** 패널이 받을 드래그인가 — dragover 에선 types 만 보인다. */
export function acceptsDrag(dt: DataTransfer | null): boolean {
  const t = dt?.types;
  if (!t) return false;
  return t.includes(QUOTE_MIME) || t.includes(ATTACH_MIME) || t.includes("Files") || t.includes("text/uri-list");
}

/** 드롭 반영(§2.2). 처리했으면 true. 우선순위: galpi 인용 → galpi 첨부 → paper:// 그림 → OS 이미지 파일. */
export function applyDrop(dt: DataTransfer, chat: ChatApi): boolean {
  const q = dt.getData(QUOTE_MIME);
  if (q) {
    try {
      const quote = JSON.parse(q);
      if (quote && typeof quote.text === "string") {
        chat.addQuote(quote);
        return true;
      }
    } catch {
      /* 형식이 틀리면 다음 후보 */
    }
  }
  const a = dt.getData(ATTACH_MIME);
  if (a) {
    try {
      const att = JSON.parse(a);
      if (att && typeof att.file === "string" && !att.file.split("/").includes("..")) {
        chat.addAttachment(att);
        return true;
      }
    } catch {
      /* 다음 후보 */
    }
  }
  // 본문 그림을 그냥 끌면 paper://<docId>/<rel> — 이미 문서 폴더에 있으니 복사 없이 참조만.
  const uris = dt.getData("text/uri-list");
  if (uris) {
    let hit = false;
    for (const line of uris.split(/\r?\n/)) {
      const p = parsePaperUrl(line);
      if (!p || p.docId.toLowerCase() !== chat.docId.toLowerCase()) continue;
      const rel = p.rel;
      if (rel.startsWith("/") || rel.split("/").includes("..") || !/\.(png|jpe?g|webp|gif)$/i.test(rel)) continue;
      chat.addAttachment(attachmentFromAsset(rel));
      hit = true;
    }
    if (hit) return true;
  }
  const files = Array.from(dt.files ?? []).filter((f) => f.type.startsWith("image/"));
  if (files.length) {
    chat.uploadBlobs(files);
    return true;
  }
  return false;
}

const CTX_LABEL: Record<ChatContextMode, string> = { full: "전문", summary: "요약", none: "없음" };
const CTX_NEXT: Record<ChatContextMode, ChatContextMode> = { full: "summary", summary: "none", none: "full" };

interface Props {
  chat: ChatApi;
  onZoom: (url: string) => void;
}

export function Composer({ chat, onZoom }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const plusBox = useRef<HTMLDivElement>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  // 문맥 토큰 견적 — 문서·모드별로 한 번만 묻는다. 키로 고르니 늦게 온 응답이 다른 모드 값을 덮지 않는다.
  const [ctxTokens, setCtxTokens] = useState<Record<string, number>>({});
  const { draft, docId, busy, context } = chat;

  // 자동 높이 — 패널 높이의 40% 까지
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const max = Math.max(80, (ta.closest(".chat-panel")?.clientHeight ?? 600) * 0.4);
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  }, [draft.text]);

  // 인용 추가·새 대화 등에서 포커스 요청 — 패널이 막 열린 참이면 보이기 전이라 한 박자 뒤에.
  useEffect(() => {
    if (!chat.focusTick) return;
    const t = setTimeout(() => taRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [chat.focusTick]);

  useEffect(() => {
    if (!plusOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (plusBox.current?.contains(t) || plusRef.current?.contains(t)) return;
      setPlusOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [plusOpen]);

  const loadCtxTip = (mode: ChatContextMode) => {
    const key = `${docId}:${mode}`;
    if (ctxTokens[key] != null) return;
    void window.paperAPI
      .chatContextInfo(docId, mode)
      .then((r) => setCtxTokens((m) => ({ ...m, [key]: r.estTokens })))
      .catch(() => {});
  };
  const est = ctxTokens[`${docId}:${context}`];

  const submit = () => {
    if (busy) return;
    void chat.send(draft.text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // 한국어 조합 중 Enter
    e.preventDefault();
    submit();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imgs = Array.from(e.clipboardData.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return; // 글자 붙여넣기는 기본 동작
    e.preventDefault();
    chat.uploadBlobs(imgs);
  };

  const canSend = !busy && (!!draft.text.trim() || draft.quotes.length > 0 || draft.attachments.length > 0);

  return (
    <div className="chat-composer">
      {draft.quotes.length > 0 && (
        <div className="chat-cq-row">
          {draft.quotes.map((q, i) => (
            <span key={i} className="chat-cq" title={q.text.slice(0, 600)}>
              <span className="chat-cq-text">{q.text}</span>
              <button className="chat-x" onClick={() => chat.removeQuote(i)} aria-label="인용 빼기">
                <svg {...ICO} width={12} height={12}><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </span>
          ))}
        </div>
      )}
      {(draft.attachments.length > 0 || draft.uploading > 0) && (
        <div className="chat-ct-row">
          {draft.attachments.map((a) => {
            const url = window.paperAPI.assetUrl(docId, a.file);
            return (
              <span key={a.id} className="chat-ct">
                <button className="chat-ct-img" onClick={() => onZoom(url)} aria-label={a.name ?? "이미지"}>
                  <img src={url} alt="" draggable={false} />
                </button>
                <button className="chat-x" onClick={() => chat.removeAttachment(a.id)} aria-label="첨부 빼기">
                  <svg {...ICO} width={11} height={11}><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </span>
            );
          })}
          {Array.from({ length: draft.uploading }, (_, i) => (
            <span key={`u${i}`} className="chat-ct pending" />
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        className="chat-input"
        rows={1}
        value={draft.text}
        onChange={(e) => chat.setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        spellCheck={false}
      />
      <div className="chat-cbar">
        <span className="chat-plus-wrap">
          <button ref={plusRef} className={`chat-ico ${plusOpen ? "on" : ""}`} onClick={() => setPlusOpen((v) => !v)} title="첨부" aria-label="첨부">
            <svg {...ICO}><path d="M12 5v14M5 12h14" /></svg>
          </button>
          {plusOpen && (
            <div className="chat-pop chat-plus-pop" ref={plusBox}>
              <button
                className="chat-pop-item"
                onClick={() => {
                  setPlusOpen(false);
                  fileRef.current?.click();
                }}
              >
                <svg {...ICO}><rect x="3.5" y="5" width="17" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M20.5 16l-5-5-8 8" /></svg>
                이미지
              </button>
              <button
                className="chat-pop-item"
                onClick={() => {
                  setPlusOpen(false);
                  window.dispatchEvent(new CustomEvent("galpi:capture-start"));
                }}
              >
                <svg {...ICO}><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" /></svg>
                화면 캡처
              </button>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              chat.uploadBlobs(files);
            }}
          />
        </span>
        <button
          className="chat-pill chat-ctx"
          onClick={() => {
            const next = CTX_NEXT[context];
            chat.setContext(next);
            loadCtxTip(next);
          }}
          onMouseEnter={() => loadCtxTip(context)}
          title={est != null ? `약 ${fmtK(est)}토큰` : undefined}
          aria-label={`문맥 ${CTX_LABEL[context]}`}
        >
          <svg {...ICO} width={13} height={13}><path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8L14 3.5z" /><path d="M14 3.5V8h4.5M9 12.5h6M9 16h4" /></svg>
          <span>{CTX_LABEL[context]}</span>
        </button>
        <ModelPicker models={chat.models} value={chat.model} onChange={chat.setModel} />
        <span className="chat-cbar-gap" />
        {busy ? (
          <button className="chat-send stop" onClick={chat.cancel} title="중단" aria-label="중단">
            <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" /></svg>
          </button>
        ) : (
          <button className="chat-send" onClick={submit} disabled={!canSend} title="전송 · Enter" aria-label="전송">
            <svg {...ICO}><path d="M12 19V5M6 11l6-6 6 6" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}
