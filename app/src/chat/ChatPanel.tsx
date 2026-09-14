// AI 채팅 패널 셸 — 도킹(좌/우, .reader-body 의 flex 자식)·플로팅(position:fixed) 공용.
//
// 리더에 늘 마운트돼 있다(닫히면 hidden). chatBus 의 quote/attach/ask 는 여기서 받는다.
// 끌기·리사이즈 중에는 React 상태를 건드리지 않고 DOM style 만 바꾸고, 놓을 때 한 번 확정한다 —
// 프레임마다 setState 하면 메시지 목록까지 다시 그린다. 배치는 settings.json `chatLayout` 에 400ms 디바운스 저장.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Block, PaperDocument } from "../types";
import { jumpWith } from "../nav/jump";
import { onChat, type ChatTab } from "./chatBus";
import { useChat } from "./useChat";
import { SummaryView, useSummary } from "./SummaryView";
import { ChatView } from "./ChatView";
import { SessionMenu } from "./SessionMenu";
import { CiteContext, type CiteApi } from "./Markdown";
import { acceptsDrag, applyDrop } from "./Composer";
import { ICO } from "./MessageItem";
import {
  DRAG_THRESHOLD,
  RESIZE_DIRS,
  clampDockWidth,
  clampFloat,
  detachRect,
  resizeFloat,
  sanitizeLayout,
  snapSide,
  type ChatLayout,
  type FloatRect,
  type ResizeDir,
} from "./layout";
import "./chat.css";

interface Props {
  doc: PaperDocument;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  viewMode: "reflow" | "source";
}

const SAVE_MS = 400;
const CURSOR: Record<ResizeDir, string> = {
  n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
  ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize",
};

function blockPreview(b: Block): string {
  const raw = b.text ?? b.latex ?? b.html ?? "";
  return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** 인용 ¶ → 본문 위치. 리플로우는 블록 요소, 원본 모드는 지면 위 블록 상자(없으면 그 쪽). */
function jumpToBlock(doc: PaperDocument, id: string, viewMode: "reflow" | "source") {
  const idx = doc.blocks.findIndex((b) => b.id === id);
  if (idx < 0) return;
  const flash = (el: HTMLElement, cls: string) => {
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 1400);
  };
  if (viewMode === "source") {
    const esc = CSS.escape(id);
    const box =
      document.querySelector<HTMLElement>(`.tr-box[data-tr-box="${esc}"]`) ??
      document.querySelector<HTMLElement>(`.src-tl-line[data-block-id="${esc}"]`);
    const target = box ?? document.querySelector<HTMLElement>(`.spread[data-page="${doc.blocks[idx].page}"]`);
    if (!target) return;
    jumpWith(target, () => target.scrollIntoView({ block: "center", behavior: "smooth" }));
    if (box?.classList.contains("tr-box")) flash(box, "on");
    return;
  }
  // 페이지 병합으로 흡수됐거나 숨긴 블록은 DOM 에 없다 — 앞쪽으로 가장 가까운 보이는 블록으로.
  let el: HTMLElement | null = null;
  for (let k = idx; k >= 0 && !el; k--) {
    el = document.querySelector<HTMLElement>(`.reader-content [data-block-id="${CSS.escape(doc.blocks[k].id)}"]`);
  }
  if (!el) return;
  const target = el;
  jumpWith(target, () => target.scrollIntoView({ block: "center", behavior: "smooth" }));
  flash(target, "ref-target-flash");
}

export function ChatPanel({ doc, open, onOpenChange, viewMode }: Props) {
  const [layout, setLayout] = useState<ChatLayout>(() => sanitizeLayout(null, window.innerWidth, window.innerHeight));
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [snap, setSnap] = useState<{ side: "left" | "right"; top: number } | null>(null);
  const [menu, setMenu] = useState<null | "sessions" | "more">(null);
  const [dropOn, setDropOn] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const histRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const moreBox = useRef<HTMLDivElement>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const openRef = useRef(open);
  openRef.current = open;
  const onOpenRef = useRef(onOpenChange);
  onOpenRef.current = onOpenChange;
  const viewRef = useRef(viewMode);
  viewRef.current = viewMode;
  const loaded = useRef(false);
  const lastSaved = useRef("");
  const saveTimer = useRef<number | null>(null);
  const dragOff = useRef<(() => void) | null>(null);
  const dragDepth = useRef(0);

  const chat = useChat(doc);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const sum = useSummary(doc.doc_id);

  const setTab = useCallback((tab: ChatTab) => setLayout((l) => (l.tab === tab ? l : { ...l, tab })), []);

  // ── 배치 복원·저장 ───────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    window.paperAPI
      .loadSettings()
      .then((g) => {
        if (!alive) return;
        const l = sanitizeLayout((g as { chatLayout?: unknown } | null)?.chatLayout, window.innerWidth, window.innerHeight);
        const next = { ...l, open: openRef.current || l.open };
        lastSaved.current = JSON.stringify(next);
        loaded.current = true;
        setLayout(next);
        if (l.open && !openRef.current) onOpenRef.current(true);
      })
      .catch(() => {
        loaded.current = true;
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setLayout((l) => (l.open === open ? l : { ...l, open }));
  }, [open]);

  const flushSave = useCallback(() => {
    if (saveTimer.current != null) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const s = JSON.stringify(layoutRef.current);
    if (s === lastSaved.current) return;
    lastSaved.current = s;
    void window.paperAPI.saveSettings({ chatLayout: layoutRef.current }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    if (saveTimer.current != null) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushSave, SAVE_MS);
  }, [layout, flushSave]);

  // 언마운트(문서 닫기) — 걸려 있는 저장은 바로 쓰고, 끌던 중이면 리스너를 푼다.
  useEffect(
    () => () => {
      if (saveTimer.current != null) flushSave();
      dragOff.current?.();
    },
    [flushSave],
  );

  // 창 크기 — 저장값은 두고 그릴 때만 클램프한다(창을 잠깐 줄였다 키워도 폭이 안 줄어든 채 남게).
  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setVp({ w: window.innerWidth, h: window.innerHeight }));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
    };
  }, []);

  // 열 때 채팅용 agy 스페어를 데운다(첫 답 지연을 줄인다). 번역 풀과 따로다.
  useEffect(() => {
    if (open) void window.paperAPI.agyPrewarm("chat").catch(() => null);
  }, [open]);

  // ── 버스 ─────────────────────────────────────────────────────────
  useEffect(
    () =>
      onChat((e) => {
        const c = chatRef.current;
        switch (e.type) {
          case "open":
            if (e.tab) setTab(e.tab);
            onOpenRef.current(true);
            break;
          case "quote":
            setTab("chat");
            onOpenRef.current(true);
            c.addQuote(e.quote);
            c.requestFocus();
            break;
          case "attach":
            setTab("chat");
            onOpenRef.current(true);
            c.addAttachment(e.attachment);
            c.requestFocus();
            break;
          case "ask":
            setTab("chat");
            onOpenRef.current(true);
            c.ask(e);
            break;
        }
      }),
    [setTab],
  );

  // ⋯ 메뉴 바깥 클릭·Esc
  useEffect(() => {
    if (menu !== "more") return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (moreBox.current?.contains(t) || moreRef.current?.contains(t)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setMenu(null);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  const closeMenu = useCallback(() => setMenu(null), []);

  // ── 인용 점프 ─────────────────────────────────────────────────────
  const citeApi = useMemo<CiteApi>(() => {
    const byId = new Map(doc.blocks.map((b) => [b.id, b]));
    return {
      title: (id) => {
        const b = byId.get(id);
        return b ? blockPreview(b) || id : undefined;
      },
      page: (id) => byId.get(id)?.page,
      jump: (id) => jumpToBlock(doc, id, viewRef.current),
    };
  }, [doc]);

  // ── 끌기·리사이즈 ─────────────────────────────────────────────────
  const floating = layout.mode === "float";
  const dockW = clampDockWidth(layout.width, vp.w);
  const fl: FloatRect = clampFloat(
    layout.float.x < 0 ? { ...layout.float, x: vp.w - layout.float.w - 24, y: 72 } : layout.float,
    vp.w,
    vp.h,
  );

  // 창 가장자리에 고정된 UI(검색 바·줌 바·원위치 버튼)가 도킹 패널을 덮지 않게 폭을 CSS 변수로 알린다.
  // 스플리터를 끄는 동안은 갱신하지 않는다(놓을 때 한 번) — 프레임마다 쓰면 그 UI 들까지 매번 다시 배치된다.
  const insetSide = open && !floating ? layout.mode : null;
  useEffect(() => {
    const host = rootRef.current?.closest<HTMLElement>(".reader-root");
    if (!host) return;
    host.style.setProperty("--chat-inset-l", insetSide === "left" ? `${dockW}px` : "0px");
    host.style.setProperty("--chat-inset-r", insetSide === "right" ? `${dockW}px` : "0px");
  }, [insetSide, dockW]);

  const track = (onMove: (ev: PointerEvent) => void, onUp: () => void, cursor?: string) => {
    dragOff.current?.();
    const body = document.body;
    const off = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      body.classList.remove("chat-dragging", "chat-resizing");
      body.style.removeProperty("--chat-cursor");
      dragOff.current = null;
    };
    const up = () => {
      off();
      onUp();
    };
    if (cursor) {
      body.classList.add("chat-resizing");
      body.style.setProperty("--chat-cursor", cursor);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    dragOff.current = off;
  };

  // 헤더 끌기 — 6px 넘게 끌면 떼어져 포인터를 따라온다. 창 좌/우 가장자리에 놓으면 그쪽에 붙는다.
  const onHeadDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, textarea, select, .chat-pop")) return;
    const root = rootRef.current;
    if (!root) return;
    e.preventDefault();
    const r = root.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const grab = { x: sx - r.left, y: sy - r.top };
    const startMode = layoutRef.current.mode;
    const bodyTop = root.parentElement?.getBoundingClientRect().top ?? 0;
    let rect: FloatRect | null = null;
    let side: "left" | "right" | null = null;
    track(
      (ev) => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (!rect) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return;
          document.body.classList.add("chat-dragging");
          setMenu(null);
          if (startMode === "float") {
            rect = { x: r.left, y: r.top, w: r.width, h: r.height };
          } else {
            const first = detachRect(layoutRef.current.float, grab, { w: r.width, h: r.height }, { x: ev.clientX, y: ev.clientY }, vw, vh);
            grab.x = ev.clientX - first.x;
            grab.y = ev.clientY - first.y;
            rect = first;
            setLayout((l) => ({ ...l, mode: "float", float: first }));
          }
        }
        rect = clampFloat({ ...rect, x: ev.clientX - grab.x, y: ev.clientY - grab.y }, vw, vh);
        const el = rootRef.current;
        if (el) {
          el.style.left = `${rect.x}px`;
          el.style.top = `${rect.y}px`;
        }
        const s = snapSide(ev.clientX, vw);
        if (s !== side) {
          side = s;
          setSnap(s ? { side: s, top: bodyTop } : null);
        }
      },
      () => {
        if (!rect) return;
        const final = rect;
        const sd = side;
        setSnap(null);
        setLayout((l) => (sd ? { ...l, mode: sd, float: final } : { ...l, mode: "float", float: final }));
      },
    );
  };

  // 도킹 폭 — 안쪽 경계 스플리터. 본문이 다시 흐르므로 DOM 쓰기는 프레임당 한 번.
  const onSplitDown = (e: React.PointerEvent) => {
    const root = rootRef.current;
    if (e.button !== 0 || !root) return;
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const left = layoutRef.current.mode === "left";
    const w0 = root.getBoundingClientRect().width;
    let w = w0;
    let raf = 0;
    const apply = () => {
      raf = 0;
      if (rootRef.current) rootRef.current.style.width = `${w}px`;
    };
    track(
      (ev) => {
        const dx = ev.clientX - sx;
        w = clampDockWidth(left ? w0 + dx : w0 - dx, window.innerWidth);
        if (!raf) raf = requestAnimationFrame(apply);
      },
      () => {
        cancelAnimationFrame(raf);
        apply();
        const final = w;
        setLayout((l) => (l.width === final ? l : { ...l, width: final }));
      },
      "col-resize",
    );
  };

  const onResizeDown = (dir: ResizeDir) => (e: React.PointerEvent) => {
    const root = rootRef.current;
    if (e.button !== 0 || !root) return;
    e.preventDefault();
    e.stopPropagation();
    const r = root.getBoundingClientRect();
    const start: FloatRect = { x: r.left, y: r.top, w: r.width, h: r.height };
    const sx = e.clientX;
    const sy = e.clientY;
    let rect = start;
    const apply = () => {
      const el = rootRef.current;
      if (!el) return;
      el.style.left = `${rect.x}px`;
      el.style.top = `${rect.y}px`;
      el.style.width = `${rect.w}px`;
      el.style.height = `${rect.h}px`;
    };
    track(
      (ev) => {
        rect = resizeFloat(start, dir, ev.clientX - sx, ev.clientY - sy, window.innerWidth, window.innerHeight);
        apply();
      },
      () => {
        apply();
        const final = rect;
        setLayout((l) => ({ ...l, float: final }));
      },
      CURSOR[dir],
    );
  };

  const dock = (side: "left" | "right") => {
    setMenu(null);
    setLayout((l) => ({ ...l, mode: side }));
  };
  const detach = () => {
    setMenu(null);
    setLayout((l) => ({ ...l, mode: "float", float: fl }));
  };

  // ── 드롭(§2.2) — 창 전역 PDF 드롭 핸들러까지 새지 않게 여기서 전파를 끊는다 ──
  const onDragEnter = (e: React.DragEvent) => {
    e.stopPropagation();
    if (!acceptsDrag(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth.current++;
    setDropOn(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.stopPropagation();
    if (acceptsDrag(e.dataTransfer)) e.preventDefault();
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.stopPropagation();
    if (!dragDepth.current) return;
    dragDepth.current--;
    if (!dragDepth.current) setDropOn(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.stopPropagation();
    dragDepth.current = 0;
    setDropOn(false);
    if (!acceptsDrag(e.dataTransfer)) return; // 글자 끌어다 놓기는 textarea 기본 동작
    e.preventDefault();
    if (applyDrop(e.dataTransfer, chat)) {
      setTab("chat");
      chat.requestFocus();
    }
  };

  const askFromSummary = useCallback(
    (q: string) => {
      setTab("chat");
      chatRef.current.ask({ text: q });
    },
    [setTab],
  );
  const questions = sum.summary?.questions ?? [];
  const tab = layout.tab;

  const style: React.CSSProperties = floating ? { left: fl.x, top: fl.y, width: fl.w, height: fl.h } : { width: dockW };

  return (
    <aside
      ref={rootRef}
      className={`chat-panel ${floating ? "chat-float" : "chat-dock"} ${dropOn ? "drop-on" : ""}`}
      data-side={floating ? undefined : layout.mode}
      hidden={!open}
      style={style}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {!floating && <div className="chat-split" onPointerDown={onSplitDown} />}
      <header className="chat-head" onPointerDown={onHeadDown}>
        <div className="chat-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "chat"} className={`chat-tab ${tab === "chat" ? "on" : ""}`} onClick={() => setTab("chat")}>
            대화
          </button>
          <button role="tab" aria-selected={tab === "summary"} className={`chat-tab ${tab === "summary" ? "on" : ""}`} onClick={() => setTab("summary")}>
            요약
          </button>
        </div>
        <span className="chat-head-gap" />
        <button
          ref={histRef}
          className={`chat-ico ${menu === "sessions" ? "on" : ""}`}
          onClick={() => setMenu((m) => (m === "sessions" ? null : "sessions"))}
          title="기록"
          aria-label="기록"
        >
          <svg {...ICO}><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></svg>
        </button>
        <button
          className="chat-ico"
          onClick={() => {
            chat.newSession();
            setTab("chat");
          }}
          title="새 대화"
          aria-label="새 대화"
        >
          <svg {...ICO}><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <button
          ref={moreRef}
          className={`chat-ico ${menu === "more" ? "on" : ""}`}
          onClick={() => setMenu((m) => (m === "more" ? null : "more"))}
          title="더보기"
          aria-label="더보기"
        >
          <svg {...ICO}><circle cx="6" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="18" cy="12" r="1.2" /></svg>
        </button>
        <button className="chat-ico" onClick={() => onOpenChange(false)} title="닫기" aria-label="닫기">
          <svg {...ICO}><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>

      {menu === "sessions" && (
        <SessionMenu
          sessions={chat.sessions}
          currentId={chat.session?.id || null}
          busySessionId={chat.busySessionId}
          onOpen={(id) => {
            chat.openSession(id);
            setTab("chat");
          }}
          onNew={() => {
            chat.newSession();
            setTab("chat");
          }}
          onRename={(id, t) => void chat.renameSession(id, t)}
          onDelete={(id) => void chat.deleteSession(id)}
          onClose={closeMenu}
          anchorRef={histRef}
        />
      )}
      {menu === "more" && (
        <div className="chat-pop chat-more" ref={moreBox}>
          {layout.mode !== "left" && <button className="chat-pop-item" onClick={() => dock("left")}>왼쪽에 붙이기</button>}
          {layout.mode !== "right" && <button className="chat-pop-item" onClick={() => dock("right")}>오른쪽에 붙이기</button>}
          {!floating && <button className="chat-pop-item" onClick={detach}>떼어내기</button>}
          <div className="ctx-sep" />
          <button
            className="chat-pop-item"
            disabled={sum.state === "running"}
            onClick={() => {
              setMenu(null);
              setTab("summary");
              sum.generate(true);
            }}
          >
            요약 다시 생성
          </button>
        </div>
      )}

      <CiteContext.Provider value={citeApi}>
        <div className="chat-body" hidden={tab !== "chat"}>
          <ChatView chat={chat} questions={questions} />
        </div>
        <div className="chat-body" hidden={tab !== "summary"}>
          <SummaryView docId={doc.doc_id} sum={sum} active={open && tab === "summary"} onAsk={askFromSummary} />
        </div>
      </CiteContext.Provider>

      {floating && RESIZE_DIRS.map((d) => <div key={d} className={`chat-rs chat-rs-${d}`} onPointerDown={onResizeDown(d)} />)}
      {snap && <div className="chat-snap" data-side={snap.side} style={{ top: snap.top, width: dockW }} />}
    </aside>
  );
}
