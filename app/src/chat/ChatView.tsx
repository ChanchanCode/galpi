// 대화 탭 — 메시지 목록(자기 스크롤) + 입력창. 빈 화면엔 요약의 추천 질문 칩만.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatApi } from "./useChat";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";

const FOLLOW_PX = 40; // 바닥에서 이 안이면 새 델타를 따라 내려간다

interface Props {
  chat: ChatApi;
  questions: string[];
}

export function ChatView({ chat, questions }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const [zoom, setZoom] = useState<string | null>(null);
  const { messages, streamingId, busy } = chat;

  const toBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // 전송·세션 전환은 무조건 바닥으로
  useLayoutEffect(() => {
    nearBottom.current = true;
    toBottom();
  }, [chat.scrollTick]);

  // Markdown 은 스로틀돼 늦게 그려진다 — 메시지 배열이 아니라 실제 높이 변화를 보고 따라간다.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const ro = new ResizeObserver(() => {
      if (nearBottom.current) toBottom();
    });
    ro.observe(list);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setZoom(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [zoom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_PX;
  };

  const onZoom = useCallback((url: string) => setZoom(url), []);
  const lastIdx = messages.length - 1;

  return (
    <div className="chat-view">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-list" ref={listRef}>
          {messages.length === 0 ? (
            questions.length > 0 ? (
              <div className="chat-empty chat-suggest">
                {questions.map((q, i) => (
                  <button key={i} className="chat-chip-q" onClick={() => void chat.send(q)}>
                    {q}
                  </button>
                ))}
              </div>
            ) : (
              <div className="chat-empty chat-logo" aria-hidden>
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 12.5a7.5 7.5 0 0 1-11 6.63L4 20.5l1.37-4.5A7.5 7.5 0 1 1 20 12.5z" />
                </svg>
              </div>
            )
          ) : (
            messages.map((m, i) => (
              <MessageItem
                key={m.id}
                msg={m}
                docId={chat.docId}
                models={chat.models}
                streaming={m.id === streamingId}
                isLast={i === lastIdx}
                busy={busy}
                onRegenerate={chat.regenerate}
                onRetry={chat.retry}
                onZoom={onZoom}
              />
            ))
          )}
        </div>
      </div>
      <Composer chat={chat} onZoom={onZoom} />
      {/* 패널(z 44/90)의 쌓임 맥락에 갇히지 않게 body 로 뺀다 */}
      {zoom &&
        createPortal(
          <div className="chat-lightbox" onClick={() => setZoom(null)}>
            <img src={zoom} alt="" draggable={false} />
          </div>,
          document.body,
        )}
    </div>
  );
}
