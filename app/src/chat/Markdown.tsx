// AI 답변 렌더 — mathMarkdown 의 HTML 을 소독해 주입한다.
//
// 소독은 **별도 DOMPurify 인스턴스**로 한다. 기본 인스턴스에 훅을 걸면 본문 RichText·표·각주의
// 소독까지 바뀐다(링크 href 가 사라진다).
// innerHTML 을 직접 쓰는 이유: 스트리밍 중 프레임마다 다시 그리는데 React 재조정은 이득이 없고,
// 끝에 커서를 끼워 넣거나 인용 링크에 title 을 다는 후처리를 한 번에 하려고.
import { createContext, memo, useContext, useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import "katex/dist/katex.min.css";
import { renderMarkdown } from "./mathMarkdown";

export interface CiteApi {
  /** 인용 블록 미리보기(앞 80자) */
  title: (blockId: string) => string | undefined;
  /** 블록이 있는 쪽(1-base). 모르면 undefined */
  page: (blockId: string) => number | undefined;
  jump: (blockId: string) => void;
}
export const CiteContext = createContext<CiteApi | null>(null);

const purify = DOMPurify(window);
// 앱 창 안에서 링크를 따라가면 리더 자체가 이동해 버린다 — href 는 늘 지우고, http(s) 만 data-href 로 남겨
// 클릭 시 외부 브라우저로 연다.
purify.addHook("afterSanitizeAttributes", (node) => {
  const el = node as Element;
  if (!el.tagName) return;
  if (el.tagName === "A") {
    const href = el.getAttribute("href") ?? "";
    el.removeAttribute("href");
    el.removeAttribute("target");
    el.removeAttribute("data-href");
    const block = el.getAttribute("data-block");
    if (block != null && !/^b\d{4,}$/.test(block)) el.removeAttribute("data-block");
    if (block == null && /^https?:\/\//i.test(href)) el.setAttribute("data-href", href);
  }
  // KaTeX 가 span 에 인라인 style 을 쓴다. 그 밖의 요소 style 은 패널 밖을 덮는 등 쓸모가 없어 뺀다.
  if (el.hasAttribute("style")) {
    if (el.tagName !== "SPAN" && el.namespaceURI !== "http://www.w3.org/2000/svg") el.removeAttribute("style");
    else if (/position\s*:\s*(fixed|absolute|sticky)/i.test(el.getAttribute("style") ?? "")) el.removeAttribute("style");
  }
});

const CFG = {
  FORBID_TAGS: ["style", "img", "form", "input", "textarea", "select", "iframe", "object", "embed", "video", "audio", "link", "meta"],
  FORBID_ATTR: ["id", "name"],
};

// 칩 글자 = 쪽. 연속이면 범위(p.7–9), 떨어져 있으면 쉼표(p.3, 12), 넷 이상이면 앞 둘 + …
function citeLabel(ids: string[], c: CiteApi | null): string {
  const pages = [...new Set(ids.map((id) => c?.page(id)).filter((p): p is number => typeof p === "number"))].sort((a, b) => a - b);
  if (!pages.length) return "↗";
  if (pages.length === 1) return `p.${pages[0]}`;
  if (pages[pages.length - 1] - pages[0] === pages.length - 1) return `p.${pages[0]}–${pages[pages.length - 1]}`;
  return pages.length <= 3 ? `p.${pages.join(", ")}` : `p.${pages[0]}, ${pages[1]}…`;
}

const STREAM_MIN_MS = 45; // 스트리밍 중 다시 그리는 최소 간격 — 긴 답에서 marked+KaTeX 를 매 프레임 돌리지 않게

function appendCaret(root: HTMLElement) {
  const cands = root.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, td, th, pre code");
  const host = (cands[cands.length - 1] as HTMLElement | undefined) ?? root;
  const caret = document.createElement("span");
  caret.className = "chat-caret";
  host.appendChild(caret);
}

interface Props {
  text: string;
  streaming?: boolean;
  className?: string;
}

export const Markdown = memo(function Markdown({ text, streaming = false, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const cite = useContext(CiteContext);
  const latest = useRef({ text, streaming, cite });
  latest.current = { text, streaming, cite };
  const raf = useRef<number | null>(null);
  const lastPaint = useRef(0);

  const paint = () => {
    const el = ref.current;
    if (!el) return;
    lastPaint.current = performance.now();
    const { text: t, streaming: s, cite: c } = latest.current;
    el.innerHTML = purify.sanitize(renderMarkdown(t, { streaming: s }), CFG) as string;
    if (s) appendCaret(el);
    for (const a of el.querySelectorAll<HTMLElement>("a.cite")) {
      const ids = (a.dataset.blocks ?? a.dataset.block ?? "").split(" ").filter(Boolean);
      a.textContent = citeLabel(ids, c);
      const tip = c?.title(ids[0] ?? "");
      if (tip) a.title = ids.length > 1 ? `${tip} 외 ${ids.length - 1}곳` : tip;
    }
  };

  useEffect(() => {
    if (!streaming) {
      if (raf.current != null) cancelAnimationFrame(raf.current);
      raf.current = null;
      paint();
      return;
    }
    if (raf.current != null) return;
    const tick = () => {
      if (performance.now() - lastPaint.current < STREAM_MIN_MS) {
        raf.current = requestAnimationFrame(tick);
        return;
      }
      raf.current = null;
      paint();
    };
    raf.current = requestAnimationFrame(tick); // paint 는 ref 로 최신값을 읽는다
  }, [text, streaming, cite]);

  useEffect(
    () => () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const onClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const c = t.closest<HTMLElement>("a.cite");
    if (c) {
      e.preventDefault();
      const id = c.dataset.block;
      if (id) latest.current.cite?.jump(id);
      return;
    }
    const copy = t.closest<HTMLElement>(".md-copy");
    if (copy) {
      const code = copy.parentElement?.querySelector("pre code")?.textContent ?? "";
      void navigator.clipboard.writeText(code).then(
        () => {
          copy.classList.add("done");
          setTimeout(() => copy.classList.remove("done"), 1200);
        },
        () => {},
      );
      return;
    }
    const link = t.closest<HTMLElement>("a[data-href]");
    if (link) {
      e.preventDefault();
      void window.paperAPI.openExternal(link.dataset.href ?? "").catch(() => {});
    }
  };

  return <div ref={ref} className={`md ${className ?? ""}`} onClick={onClick} />;
});
