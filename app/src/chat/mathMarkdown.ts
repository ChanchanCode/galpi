// AI 답변 Markdown + LaTeX → HTML 문자열 (순수, DOM 없음 — node 테스트 대상).
//
// marked 에 수식을 그대로 넘기면 `a_1 * b_2` 의 `_`/`*` 가 강조로 먹히고, 표 안 `$|x|$` 의 `|` 가
// 셀을 가른다. 그래서 순서가 중요하다:
//   ① 코드(펜스·인라인)는 수식 추출에서 제외  ② 수식을 자리표시자로 빼냄  ③ marked
//   ④ 자리표시자 → KaTeX  ⑤ [b0042] → 인용 링크  ⑥ 스트리밍이면 미종결 펜스·$$ 를 임시로 닫음
// 소독(DOMPurify)은 렌더러(Markdown.tsx) 몫이다 — 여기서는 DOM 을 만들 수 없다.
import katex from "katex";
import { Marked, type Tokens } from "marked";

export interface RenderOpts {
  /** 스트리밍 중 — 닫히지 않은 코드펜스·`$$` 를 임시로 닫아 화면이 깨지지 않게 한다. */
  streaming?: boolean;
}

interface MathItem {
  tex: string;
  display: boolean;
  raw: string; // 원문(구분자 포함) — 코드 안·속성 안에서는 이것으로 되돌린다
  pending: boolean; // 스트리밍 중 아직 안 닫힌 블록 수식
}

// 사용자 입력에 우연히 섞일 일이 없는 사설 영역 문자. 원문에 있으면 먼저 지운다(자리표시자 위조 방지).
const PH_L = "\uE000";
const PH_R = "\uE001";
const PH_RE = /\uE000(\d+)\uE001/g;

// ── ① 코드 영역 나누기 ──────────────────────────────────────────────
interface Seg {
  code: boolean;
  text: string;
}

const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})([^\n]*)$/;

/** 펜스 코드블록 단위로 자른다. 목록 안 펜스는 들여쓰기가 깊어서 들여쓰기 제한을 두지 않는다. */
function splitFences(src: string, streaming: boolean): Seg[] {
  const lines = src.split("\n");
  const segs: Seg[] = [];
  let buf: string[] = [];
  let i = 0;
  const flush = (code: boolean) => {
    if (!buf.length) return;
    segs.push({ code, text: buf.join("\n") });
    buf = [];
  };
  while (i < lines.length) {
    const m = FENCE_OPEN.exec(lines[i]);
    // 백틱 펜스의 info 문자열에는 백틱이 올 수 없다(CommonMark) — "```a```" 는 인라인 코드다.
    if (!m || (m[2][0] === "`" && m[3].includes("`"))) {
      buf.push(lines[i]);
      i++;
      continue;
    }
    flush(false);
    const ch = m[2][0];
    const len = m[2].length;
    const close = new RegExp(`^[ \\t]*${ch === "`" ? "`" : "~"}{${len},}[ \\t]*$`);
    const code: string[] = [lines[i]];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      code.push(lines[j]);
      if (close.test(lines[j])) {
        closed = true;
        j++;
        break;
      }
    }
    if (!closed && streaming) {
      // 스트리밍 중 미종결 — 닫는 펜스를 임시로 붙인다(marked 도 끝까지 코드로 본다).
      code.push(`${m[1]}${m[2]}`);
    }
    segs.push({ code: true, text: code.join("\n") });
    i = j;
  }
  flush(false);
  return segs; // 세그먼트는 줄 단위로 잘렸다 — 합칠 때 사이에 "\n" 을 되살린다
}

/** 인라인 코드 스팬을 떼어낸다. 같은 길이 백틱으로 닫혀야 코드이고, 빈 줄은 넘지 않는다. */
function splitCodeSpans(text: string): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`" || (i > 0 && text[i - 1] === "\\")) {
      i++;
      continue;
    }
    let n = 0;
    while (text[i + n] === "`") n++;
    let k = i + n;
    let found = -1;
    while (k < text.length) {
      const b = text.indexOf("`", k);
      if (b < 0) break;
      let m = 0;
      while (text[b + m] === "`") m++;
      if (m === n) {
        found = b;
        break;
      }
      k = b + m;
    }
    if (found < 0 || /\n[ \t]*\n/.test(text.slice(i, found))) {
      i += n;
      continue;
    }
    if (i > last) out.push({ code: false, text: text.slice(last, i) });
    out.push({ code: true, text: text.slice(i, found + n) });
    i = last = found + n;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}

// ── ② 수식 추출 ───────────────────────────────────────────────────
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

/** `$…$` 닫는 위치. 첫 번째로 만나는 `$` 가 닫는 조건을 못 채우면 수식이 아니다(통화 오인 방지). */
function inlineClose(s: string, from: number): number {
  for (let k = from; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") {
      k++;
      continue;
    }
    if (c === "\n" && /^\n[ \t]*\n/.test(s.slice(k, k + 64))) return -1;
    if (c !== "$") continue;
    if (s[k + 1] === "$") return -1;
    if (isSpace(s[k - 1])) return -1; // "$5 and $10" — 공백 뒤 $ 는 닫는 $ 가 아니다
    if (isDigit(s[k + 1])) return -1; // "$5-$10" — 닫는 $ 바로 뒤 숫자는 통화
    return k;
  }
  return -1;
}

/** 이스케이프를 건너뛰며 needle 을 찾는다. */
function findUnescaped(s: string, needle: string, from: number): number {
  for (let k = from; k <= s.length - needle.length; k++) {
    if (s[k] === "\\" && !needle.startsWith("\\")) {
      k++;
      continue;
    }
    if (s.startsWith(needle, k)) return k;
    if (s[k] === "\\") k++; // needle 이 \] 류일 때도 \\ 쌍은 건너뛴다
  }
  return -1;
}

function extractMath(s: string, math: MathItem[], streaming: boolean): string {
  let out = "";
  let i = 0;
  const push = (tex: string, display: boolean, raw: string, pending = false) => {
    out += `${PH_L}${math.length}${PH_R}`;
    math.push({ tex, display, raw, pending });
  };
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const nx = s[i + 1];
      if (nx === "[" || nx === "(") {
        const closeTok = nx === "[" ? "\\]" : "\\)";
        const j = findUnescaped(s, closeTok, i + 2);
        const body = j >= 0 ? s.slice(i + 2, j) : "";
        if (j >= 0 && body.trim() && (nx === "[" || !/\n[ \t]*\n/.test(body))) {
          push(body, nx === "[", s.slice(i, j + 2));
          i = j + 2;
          continue;
        }
        if (j < 0 && nx === "[" && streaming) {
          push(s.slice(i + 2), true, s.slice(i), true);
          i = s.length;
          continue;
        }
      }
      // \$ · \\ 등 이스케이프 쌍은 그대로 marked 에 넘긴다(marked 가 \$ → $ 로 푼다).
      out += c + (nx ?? "");
      i += 2;
      continue;
    }
    if (c === "$") {
      if (s[i + 1] === "$") {
        const j = findUnescaped(s, "$$", i + 2);
        if (j >= 0) {
          const body = s.slice(i + 2, j);
          if (body.trim()) {
            push(body, true, s.slice(i, j + 2));
            i = j + 2;
            continue;
          }
        } else if (streaming) {
          push(s.slice(i + 2), true, s.slice(i), true);
          i = s.length;
          continue;
        }
        out += "$$";
        i += 2;
        continue;
      }
      if (!isSpace(s[i + 1])) {
        const j = inlineClose(s, i + 1);
        if (j > i + 1) {
          const body = s.slice(i + 1, j);
          // "$5 million … x$" 류 — 숫자로 시작해 공백 뒤 낱말이 오면 통화 문장이다.
          if (!/^\d[\d,.]*\s+[A-Za-z\uAC00-\uD7A3]/.test(body)) {
            push(body, false, s.slice(i, j + 1));
            i = j + 1;
            continue;
          }
        }
      }
      out += "$";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ── ④ KaTeX ────────────────────────────────────────────────────────
const katexCache = new Map<string, string | null>();

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderMath(m: MathItem): string {
  const raw = `<span class="math-raw${m.display ? " math-display" : ""}${m.pending ? " math-pending" : ""}">${escapeHtml(m.raw)}</span>`;
  // 스트리밍 중 반쯤 온 블록 수식은 매 프레임 렌더/실패가 번갈아 깜빡인다 — 닫힐 때까지 원문으로 둔다.
  if (m.pending) return raw;
  const tex = m.tex.replace(/\\label\{[^}]*\}/g, "").trim(); // KaTeX 가 모르는 \label 은 떼어도 뜻이 같다
  const key = `${m.display ? 1 : 0}${tex}`;
  let html = katexCache.get(key);
  if (html === undefined) {
    try {
      // throwOnError:false 는 빨간 오류 조각을 그린다 — "깨진 수식"을 보이지 않으려고 잡아서 원문으로 낸다.
      html = katex.renderToString(tex, { displayMode: m.display, throwOnError: true, output: "html", strict: "ignore", trust: false, maxExpand: 500 });
    } catch {
      html = null;
    }
    if (katexCache.size > 600) katexCache.clear();
    katexCache.set(key, html);
  }
  if (html === null) return raw;
  return m.display ? `<span class="math-display">${html}</span>` : `<span class="math-inline">${html}</span>`;
}

// ── ③ marked ───────────────────────────────────────────────────────
// 코드 안에 들어간 자리표시자는 원문으로 되돌린다(들여쓰기 코드블록처럼 ①이 못 본 코드도 여기서 잡힌다).
let curMath: MathItem[] = [];
const restoreRaw = (s: string) => s.replace(PH_RE, (_, n) => curMath[Number(n)]?.raw ?? "");

const COPY_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/></svg>';

const md = new Marked({ gfm: true, breaks: false, async: false });
md.use({
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const code = restoreRaw(text).replace(/\n$/, "");
      const l = (lang ?? "").match(/^[\w+#.-]+/)?.[0] ?? "";
      return (
        `<div class="md-code">` +
        (l ? `<span class="md-lang">${escapeHtml(l)}</span>` : "") +
        `<button class="md-copy" type="button" title="복사" aria-label="복사">${COPY_SVG}</button>` +
        `<pre><code${l ? ` class="language-${escapeHtml(l)}"` : ""}>${escapeHtml(code)}</code></pre></div>\n`
      );
    },
    codespan({ text }: Tokens.Codespan) {
      return `<code>${escapeHtml(restoreRaw(text))}</code>`;
    },
  },
});

// ── ⑤ 인용 ─────────────────────────────────────────────────────────
const CITE_ONE = String.raw`\[\s*b\d{4,}(?:\s*[,;]\s*b\d{4,})*\s*\]`;
// 공백만 사이에 두고 이어진 묶음([b1] [b2])은 칩 하나로 합친다 — 문장마다 칩이 줄지어 서면 읽기를 방해한다(사용자 신고).
const CITE_RE = new RegExp(`${CITE_ONE}(?:\\s*${CITE_ONE})*`, "g");

/** 인용 묶음 → 칩 하나. 표시 글자(쪽 번호)는 문서를 아는 Markdown.tsx 가 채운다. 여기선 자리 글자만. */
export function citeHtml(ids: string[]): string {
  const uniq = [...new Set(ids)];
  return `<a class="cite" data-block="${uniq[0]}" data-blocks="${uniq.join(" ")}">↗</a>`;
}

/** 태그 밖 텍스트에서만 자리표시자·인용을 바꾼다. 태그 속성(alt 등) 안이면 원문으로, 코드 안이면 인용을 건드리지 않는다. */
function substitute(html: string, math: MathItem[]): string {
  const parts = html.split(/(<[^>]*>)/);
  let codeDepth = 0;
  for (let p = 0; p < parts.length; p++) {
    const s = parts[p];
    if (!s) continue;
    if (p % 2 === 1) {
      const t = /^<(\/?)(code|pre)\b/i.exec(s);
      if (t) codeDepth = Math.max(0, codeDepth + (t[1] ? -1 : 1));
      if (s.includes(PH_L)) parts[p] = s.replace(PH_RE, (_, n) => escapeHtml(math[Number(n)]?.raw ?? ""));
      continue;
    }
    let t = s;
    if (!codeDepth) t = t.replace(CITE_RE, (m: string) => citeHtml(m.match(/b\d{4,}/g) ?? []));
    t = t.replace(PH_RE, (_, n) => {
      const m = math[Number(n)];
      return m ? (codeDepth ? escapeHtml(m.raw) : renderMath(m)) : "";
    });
    parts[p] = t;
  }
  return parts.join("");
}

// ── 공개 API ───────────────────────────────────────────────────────
export function renderMarkdown(src: string, opts: RenderOpts = {}): string {
  const streaming = !!opts.streaming;
  const clean = (src ?? "").replace(/\r\n?/g, "\n").replace(/[\uE000\uE001]/g, "");
  if (!clean.trim()) return "";
  const segs = splitFences(clean, streaming);
  const math: MathItem[] = [];
  let prepared = "";
  segs.forEach((seg, idx) => {
    if (idx > 0) prepared += "\n";
    if (seg.code) {
      prepared += seg.text;
      return;
    }
    for (const sp of splitCodeSpans(seg.text)) prepared += sp.code ? sp.text : extractMath(sp.text, math, streaming);
  });
  curMath = math;
  let html: string;
  try {
    html = md.parse(prepared) as string;
  } finally {
    curMath = [];
  }
  return substitute(html, math);
}

/** 인용 id 목록(중복 제거, 등장 순). 코드 안 것도 포함되는 근사치 — 툴팁 미리 계산용. */
export function citeIds(src: string): string[] {
  const seen = new Set<string>();
  for (const m of (src ?? "").matchAll(CITE_RE)) for (const id of m[0].match(/b\d{4,}/g) ?? []) seen.add(id);
  return [...seen];
}
