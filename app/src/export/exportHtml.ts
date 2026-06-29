// 자립형 HTML 내보내기 — 현재 열린 문서를 "현재 프리셋(타이포·테마) 그대로" 한 파일로 굳혀
// AirDrop 으로 아이패드에 보내 Safari 에서 읽게 한다. 포커스(문단/문장) 기능이 그 안에서 동작한다.
//
// 방식: 화면에 이미 렌더된 .reader-content DOM 을 그대로 직렬화한다(KaTeX 렌더 결과·표·그림 포함).
//  - 이미지(paper://)는 data: URL 로 인라인 → 완전 자립.
//  - 앱 CSS 는 현재 적용된 스타일시트를 통째로 인라인(단, KaTeX 폰트 @font-face 만 제외 → CDN 사용).
//  - 포커스 런타임(바닐라)을 <script> 로 심는다.
import type { PaperDocument } from "../types";
import FOCUS_RUNTIME from "./focus-runtime.js?raw";

const KATEX_CDN = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";

// 내보내기 전용 보강 CSS — 본문 스크롤 컨테이너를 화면 전체로 + 우상단 포커스 토글/메뉴 + 돌아가기.
const STANDALONE_CSS = `
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--fg); }
.reader-scroll { height: 100vh; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.reader-content { padding-bottom: 64px; }
body[data-focus] .reader-content { cursor: pointer; } /* 포커스 중 좌/우 탭으로 이동 */
/* iOS Safari 는 cursor:pointer 가 있어야 비-인터랙티브 요소의 탭에도 click 이벤트를 확실히 보냄 */
.refl, .fn-ref { cursor: pointer; }

.gx-toggle {
  position: fixed; top: 14px; right: 14px; z-index: 101;
  width: 40px; height: 40px; border-radius: 50%; cursor: pointer;
  font-size: 1.1rem; line-height: 1; display: flex; align-items: center; justify-content: center;
  background: var(--bg); color: var(--fg); border: 1px solid var(--rule);
  box-shadow: 0 4px 16px rgba(0,0,0,0.18); -webkit-tap-highlight-color: transparent;
}
.gx-toggle.active { border-color: var(--accent); color: var(--accent); }
.gx-toggle.open { background: var(--accent); color: #fff; border-color: var(--accent); }

.gx-menu {
  position: fixed; top: 62px; right: 14px; z-index: 101;
  display: flex; flex-direction: column; gap: 3px; padding: 5px;
  background: var(--bg); border: 1px solid var(--rule); border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.28); min-width: 88px;
}
.gx-menu[hidden] { display: none; }
.gx-menu button {
  font: inherit; font-size: 0.92rem; text-align: left; cursor: pointer;
  border: none; background: transparent; color: var(--fg);
  padding: 9px 13px; border-radius: 8px; -webkit-tap-highlight-color: transparent;
}
.gx-menu button.on { background: var(--accent); color: #fff; }

.gx-back {
  position: fixed; left: 18px; bottom: 18px; z-index: 101;
  font: inherit; font-size: 0.86rem; cursor: pointer;
  background: var(--fg); color: var(--bg); border: none;
  border-radius: 999px; padding: 9px 16px; box-shadow: 0 6px 22px rgba(0,0,0,0.32);
  -webkit-tap-highlight-color: transparent;
}
.gx-back[hidden] { display: none; }

.gx-toc-toggle {
  position: fixed; top: 14px; right: 62px; z-index: 101;
  width: 40px; height: 40px; border-radius: 50%; cursor: pointer;
  font-size: 1rem; line-height: 1; display: flex; align-items: center; justify-content: center;
  background: var(--bg); color: var(--fg); border: 1px solid var(--rule);
  box-shadow: 0 4px 16px rgba(0,0,0,0.18); -webkit-tap-highlight-color: transparent;
}
.gx-toc-toggle[hidden] { display: none; }
.gx-toc {
  position: fixed; top: 62px; right: 14px; z-index: 101;
  width: min(280px, 78vw); max-height: 64vh; overflow-y: auto;
  display: flex; flex-direction: column; padding: 6px;
  background: var(--bg); border: 1px solid var(--rule); border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.28);
}
.gx-toc[hidden] { display: none; }
.gx-toc-item {
  font: inherit; font-size: 0.86rem; text-align: left; cursor: pointer;
  border: none; background: transparent; color: var(--fg);
  padding: 7px 10px; border-radius: 7px; -webkit-tap-highlight-color: transparent;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.gx-toc-item.lvl3 { padding-left: 22px; font-size: 0.82rem; color: var(--muted); }
.gx-toc-item.lvl4 { padding-left: 34px; font-size: 0.8rem; color: var(--muted); }

.ref-target-flash { animation: gx-flash 1.4s ease-out; }
@keyframes gx-flash {
  0%, 100% { background: transparent; }
  20% { background: color-mix(in srgb, var(--accent) 24%, transparent); }
}
`;

// 현재 문서의 스타일시트들을 한 문자열로. KaTeX 폰트(@font-face)만 제외(깨진 번들 URL 대신 CDN 사용).
function collectCss(): string {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // 교차출처 등 — 건너뜀
    }
    for (const rule of Array.from(rules)) {
      // KaTeX 폰트 @font-face 는 제외(번들 url 이 자립 파일에선 깨짐). 레이아웃 규칙은 유지.
      if (rule instanceof CSSFontFaceRule && /KaTeX_/.test(rule.cssText)) continue;
      parts.push(rule.cssText);
    }
  }
  return parts.join("\n");
}

// blob → data: URL
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// 복제본 안 모든 <img> 의 비-data src 를 data: URL 로 인라인.
async function inlineImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute("src");
      if (!src || src.startsWith("data:")) return;
      try {
        const res = await fetch(src);
        const blob = await res.blob();
        img.setAttribute("src", await blobToDataUrl(blob));
      } catch {
        /* 못 불러온 이미지는 그대로(깨진 링크) 둠 */
      }
      img.removeAttribute("loading");
    }),
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;"); // 속성값(style/title) 안전
}

// 현재 화면의 .reader-content 를 굳혀 완성 HTML 문자열을 만든다.
export async function buildStandaloneHtml(doc: PaperDocument): Promise<string> {
  const live = document.querySelector(".reader-content") as HTMLElement | null;
  if (!live) throw new Error("본문을 찾을 수 없습니다.");

  const clone = live.cloneNode(true) as HTMLElement;
  // 임시로 붙여 fetch/직렬화(레이아웃 불필요). 화면 밖.
  await inlineImages(clone);

  const styleVars = live.getAttribute("style") ?? ""; // 현재 타이포 CSS 변수
  const theme = document.body.dataset.theme ?? "light";
  const title = doc.title ?? doc.doc_id;
  const css = collectCss();

  const controls = `
    <button class="gx-toc-toggle" aria-label="목차" title="목차">☰</button>
    <div class="gx-toc" role="menu" aria-label="목차" hidden></div>
    <button class="gx-toggle" aria-label="포커스" title="포커스">◎</button>
    <div class="gx-menu" role="menu" aria-label="포커스" hidden>
      <button data-mode="off" class="on">읽기</button>
      <button data-mode="paragraph">문단</button>
      <button data-mode="sentence">문장</button>
    </div>
    <button class="gx-back" title="이전 위치로 (Esc)" hidden>↩ 돌아가기</button>`;

  // 복제본의 style 속성은 article 태그에 다시 부여(타이포 변수).
  clone.removeAttribute("style");

  return `<!doctype html>
<html lang="ko" data-theme="${escapeHtml(theme)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)} · 갈피</title>
<link rel="stylesheet" href="${KATEX_CDN}">
<style>${css}</style>
<style>${STANDALONE_CSS}</style>
</head>
<body data-theme="${escapeHtml(theme)}">
${controls}
<main class="reader-scroll">
<article class="reader-content" style="${escapeHtml(styleVars)}">
${clone.innerHTML}
</article>
</main>
<script>${FOCUS_RUNTIME}</script>
</body>
</html>`;
}

// 파일명용 안전 문자열
function safeFileName(s: string): string {
  return (s || "galpi").replace(/[\/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

// 현재 문서를 내보내고 저장 다이얼로그 → 결과 경로(또는 취소).
export async function exportDocToHtml(doc: PaperDocument): Promise<{ path?: string; canceled?: boolean }> {
  const html = await buildStandaloneHtml(doc);
  return window.paperAPI.exportHtml(html, `${safeFileName(doc.title ?? doc.doc_id)}.html`);
}
