// 그림·표 → 채팅 (SPEC §4.7).
//  · 리플로우 본문의 그림/표 블록 우클릭 → `AI에게 설명` · `채팅에 첨부`
//    그림은 이미지 첨부(+캡션 인용), 표는 표 텍스트 인용(HTML 이 없고 이미지 폴백뿐이면 이미지 첨부).
//  · 그림 <img> 끌기 → application/x-galpi-attach (복사 없이 assets 참조)
// 우클릭은 대상을 본문 그림/표로 한정한다 — 번역 카드 메뉴(TrCardMenu)·우클릭 번역과 부딪히지 않게.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Block, PaperDocument } from "../types";
import type { ChatAttachment, ChatQuote } from "../../electron/preload";
import { attachmentFromAsset, emitChat } from "../chat/chatBus";
import { attachmentFromImg, MIME_ATTACH, normalizeQuote, rangeText } from "./quote";
import "./selection.css";

const TARGET = ".reader-content .blk-figure, .reader-content .blk-table";

interface Menu {
  x: number;
  y: number;
  kind: "figure" | "table";
  attachment: ChatAttachment | null;
  quote: ChatQuote | null;
}

function textOf(el: Element | null): string {
  if (!el) return "";
  const r = document.createRange();
  r.selectNodeContents(el);
  return normalizeQuote(rangeText(r), "source");
}

// 캡션: 그림 안 figcaption → 없으면 이웃 캡션 블록(그림은 아래, 표는 위가 흔하다).
function captionOf(blk: HTMLElement, kind: Menu["kind"]): Element | null {
  const own = blk.querySelector("figcaption");
  if (own) return own;
  const isCap = (e: Element | null) => (e?.classList.contains("blk-caption") ? e : null);
  const next = isCap(blk.nextElementSibling);
  const prev = isCap(blk.previousElementSibling);
  return kind === "figure" ? next ?? prev : prev ?? next;
}

function blockIdOf(el: Element | null): string | undefined {
  const id = el?.closest<HTMLElement>("[data-block-id]")?.dataset.blockId;
  return id && !id.startsWith("fn-") ? id : undefined;
}

function attachmentFor(blk: HTMLElement, block: Block | undefined, docId: string): ChatAttachment | null {
  const id = blk.dataset.blockId;
  if (block?.image) return attachmentFromAsset(block.image, id);
  const img = blk.querySelector("img");
  return img ? attachmentFromImg(img, docId) : null;
}

export function FigureMenu({ doc }: { doc: PaperDocument }) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const byId = useMemo(() => new Map(doc.blocks.map((b) => [b.id, b])), [doc]);
  const ctx = useRef({ byId, docId: doc.doc_id });
  ctx.current = { byId, docId: doc.doc_id };

  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      if (e.defaultPrevented) return; // 우클릭 번역 등 먼저 처리한 쪽이 있다
      const t = e.target instanceof Element ? e.target : null;
      const blk = t?.closest<HTMLElement>(TARGET);
      if (!blk || t!.closest(".tr-card, .chat-panel")) return;
      const kind = blk.classList.contains("blk-table") ? "table" : "figure";
      const block = ctx.current.byId.get(blk.dataset.blockId ?? "");
      const attachment = attachmentFor(blk, block, ctx.current.docId);
      const cap = captionOf(blk, kind);
      let quote: ChatQuote | null = null;
      if (kind === "figure") {
        const text = textOf(cap);
        if (text) quote = { text, origin: "source", blockId: blockIdOf(cap) };
      } else {
        const table = blk.querySelector(".table-scroll table");
        const text = table ? normalizeQuote([textOf(cap), textOf(table)].filter(Boolean).join("\n\n"), "source") : "";
        if (table && text) quote = { text, origin: "source", blockId: blk.dataset.blockId };
      }
      if (quote && !quote.blockId) delete quote.blockId;
      if (!attachment && !quote) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, kind, attachment, quote });
    };

    // 그림 끌기 → 첨부. 텍스트 선택 끌기(인용)는 SelectionToolbar 가 맡는다.
    const onDragStart = (e: DragEvent) => {
      const img = e.target instanceof HTMLImageElement ? e.target : null;
      const dt = e.dataTransfer;
      const blk = img?.closest<HTMLElement>(TARGET);
      if (!img || !dt || !blk) return;
      const att = attachmentFor(blk, ctx.current.byId.get(blk.dataset.blockId ?? ""), ctx.current.docId);
      if (att) dt.setData(MIME_ATTACH, JSON.stringify(att));
    };

    window.addEventListener("contextmenu", onCtx);
    window.addEventListener("dragstart", onDragStart, true);
    return () => {
      window.removeEventListener("contextmenu", onCtx);
      window.removeEventListener("dragstart", onDragStart, true);
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  // 문서가 바뀌면 닫는다.
  useEffect(() => setMenu(null), [doc.doc_id]);

  if (!menu) return null;
  const close = () => setMenu(null);
  const { attachment, quote, kind } = menu;

  const explain = () => {
    if (kind === "figure") {
      emitChat({
        type: "ask",
        text: "이 그림을 설명해줘",
        attachments: attachment ? [attachment] : undefined,
        quotes: quote ? [quote] : undefined,
      });
    } else {
      emitChat({
        type: "ask",
        text: "이 표를 설명해줘",
        quotes: quote ? [quote] : undefined,
        attachments: !quote && attachment ? [attachment] : undefined,
      });
    }
    close();
  };
  const attach = () => {
    // 그림은 이미지가 본체, 표는 글자가 본체(모델이 숫자를 정확히 읽는다).
    if (kind === "figure" ? attachment : !quote && attachment) emitChat({ type: "attach", attachment: attachment! });
    else if (quote) emitChat({ type: "quote", quote });
    close();
  };

  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 170));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 100));
  return createPortal(
    <>
      <div
        className="ctx-backdrop"
        onMouseDown={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
        onWheel={close}
      />
      <div className="ctx-menu" role="menu" style={{ left, top }}>
        <button className="ctx-item" role="menuitem" onClick={explain}>AI에게 설명</button>
        <button className="ctx-item" role="menuitem" onClick={attach}>채팅에 첨부</button>
      </div>
    </>,
    document.body,
  );
}
