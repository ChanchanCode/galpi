// 채팅·요약용 순수 헬퍼 — 대화 → AIMessage[] 조립, 요약 JSON 살리기, 인용 id 추출, 자동 제목, 이미지 헤더.
// electron 무관(node 테스트에서 dist-test/chatParse.cjs 로 부른다).
import type { ChatAttachment, ChatQuote, ChatSession, PaperSummary } from "./chatTypes";
import type { AIMessage, AIPart } from "./types";

export const HISTORY_CHAR_CAP = 40_000;
export const IMAGE_WINDOW = 2;
export const OMITTED_IMAGE = "[이전 이미지 첨부 생략]";

export interface CurrentTurn {
  text: string;
  quotes?: ChatQuote[];
  attachments?: ChatAttachment[];
}

export interface BuildOpts {
  historyCharCap?: number;
  imageWindow?: number;
}

/** 인용은 블록인용으로 — 모델이 "사용자가 짚은 구절"과 질문을 섞지 않게. 출처 id 를 달아 인용 근거로 쓰게 한다. */
export function quoteBlock(q: ChatQuote): string {
  const body = String(q.text ?? "")
    .trim()
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
  const src = [q.blockId ? `[${q.blockId}]` : "", q.page ? `p.${q.page}` : "", q.origin === "translation" ? "번역문" : ""]
    .filter(Boolean)
    .join(" ");
  return src ? `${body}\n> — ${src}` : body;
}

export function userText(m: { text: string; quotes?: ChatQuote[] }): string {
  const qs = (m.quotes ?? []).filter((q) => q?.text?.trim()).map(quoteBlock);
  return [...qs, (m.text ?? "").trim()].filter(Boolean).join("\n\n");
}

/**
 * 세션 기록 + 이번 질문 → AIMessage[] (마지막 원소가 이번 질문).
 *  · 오류·중단으로 **빈** assistant 는 뺀다(부분 텍스트가 있으면 남긴다).
 *  · 과거 텍스트 합계 historyCharCap 을 넘으면 오래된 것부터 버린다. 이번 질문은 절대 안 버린다.
 *  · 이미지는 첨부가 있는 user 메시지 중 **마지막 imageWindow 개만** 실제로 싣는다 — 과거 이미지를
 *    매 턴 다시 보내면 턴마다 수천 토큰이 누적된다. 그 전 것은 자리표시 한 줄.
 *  · resolveAbs 가 null 을 주는 첨부(경로 탈출·파일 없음)는 조용히 뺀다.
 */
export function buildChatMessages(
  session: Pick<ChatSession, "messages">,
  current: CurrentTurn,
  resolveAbs: (file: string) => string | null,
  opts: BuildOpts = {},
): AIMessage[] {
  const cap = opts.historyCharCap ?? HISTORY_CHAR_CAP;
  const win = opts.imageWindow ?? IMAGE_WINDOW;

  type Turn = { role: "user" | "assistant"; text: string; attachments: ChatAttachment[] };
  const past: Turn[] = [];
  for (const m of session.messages ?? []) {
    if (m.role === "assistant") {
      if (!(m.text ?? "").trim() && (m.status === "error" || m.status === "canceled")) continue;
      if (!(m.text ?? "").trim()) continue; // 빈 답은 어떤 상태든 대화에 보탬이 안 된다
      past.push({ role: "assistant", text: m.text.trim(), attachments: [] });
    } else if (m.role === "user") {
      past.push({ role: "user", text: userText(m), attachments: m.attachments ?? [] });
    }
  }

  // 오래된 것부터 버린다. 남은 첫 턴이 assistant 면 그것도 버린다(대화는 user 로 시작해야 한다 — Gemini).
  let total = past.reduce((n, t) => n + t.text.length, 0);
  while (past.length && (total > cap || past[0].role === "assistant")) total -= past.shift()!.text.length;

  const cur: Turn = { role: "user", text: userText(current), attachments: current.attachments ?? [] };
  const turns = [...past, cur];

  // 이미지 창: 첨부가 있는 user 턴의 인덱스 중 뒤에서 win 개
  const withImg = turns.map((t, i) => (t.role === "user" && t.attachments.length ? i : -1)).filter((i) => i >= 0);
  const live = new Set(withImg.slice(Math.max(0, withImg.length - win)));

  const out: AIMessage[] = [];
  turns.forEach((t, i) => {
    const parts: AIPart[] = [];
    if (t.attachments.length) {
      if (live.has(i)) {
        for (const a of t.attachments) {
          const abs = a?.file ? resolveAbs(a.file) : null;
          if (abs) parts.push({ type: "image", path: abs, mime: a.mime || "image/png" });
        }
      } else {
        parts.push({ type: "text", text: OMITTED_IMAGE });
      }
    }
    if (t.text) parts.push({ type: "text", text: t.text });
    if (!parts.length) return;
    // 같은 역할이 연달아 오면(가운데 빈 답이 빠진 경우) 한 메시지로 합친다 — 역할 교대를 요구하는 API 가 있다.
    const prev = out[out.length - 1];
    if (prev && prev.role === t.role) prev.parts.push(...parts);
    else out.push({ role: t.role, parts });
  });
  return out;
}

/** 첫 줄 40자(코드포인트). Markdown 머리 기호는 뗀다. */
export function autoTitle(text: string): string {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s>#*\-]+/, "").replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!line) return "새 대화";
  const cps = [...line];
  return cps.length > 40 ? cps.slice(0, 40).join("").trimEnd() + "…" : line;
}

/** 답변 속 [b0042] · [b0042, b0051] → 블록 id 목록(등장 순, 중복 제거). */
export function extractCites(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\[(b\d{3,6}(?:\s*[,;]\s*b\d{3,6})*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text ?? "")))) {
    for (const id of m[1].split(/\s*[,;]\s*/)) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

// ── 요약 JSON ────────────────────────────────────────────────────────
const STR_FIELDS = ["tldr", "question", "method", "data"] as const;
const LIST_FIELDS = ["findings", "contributions", "limitations", "keywords", "questions"] as const;

/** 코드펜스·앞뒤 잡음 제거 → JSON.parse, 실패하면 잘린 JSON 을 닫아서 살린다. 알려진 필드가 하나도 없으면 null. */
export function parseSummaryJson(raw: string): Partial<PaperSummary> | null {
  let t = String(raw ?? "").trim();
  const fence = t.match(/```(?:json|JSON)?\s*([\s\S]*?)(?:```|$)/);
  if (fence && fence[1].includes("{")) t = fence[1].trim();
  const first = t.indexOf("{");
  if (first < 0) return null;
  t = fixJsonStrings(t.slice(first));
  let obj: unknown = null;
  const last = t.lastIndexOf("}");
  if (last > 0) {
    try {
      obj = JSON.parse(t.slice(0, last + 1));
    } catch {
      obj = null;
    }
  }
  if (!obj || typeof obj !== "object") obj = repairJson(t);
  return normalizeSummary(obj);
}

// 모델이 JSON 문자열 안에 LaTeX 역슬래시를 한 번만 쓰는 일이 잦다: "\beta" 는 JSON 에선 백스페이스+eta,
// "\alpha" 는 잘못된 이스케이프라 파싱 자체가 죽는다. 문자열 안에서만 고친다:
//  · JSON 에 없는 이스케이프(\a \s \l …) → 역슬래시를 두 번
//  · 유효 이스케이프라도 뒤가 흔한 LaTeX 명령이면(\beta \frac \theta \nu \right …) → 두 번
//  · 문자열 안 날 줄바꿈·탭 → \n \t
const LATEX_ON_VALID_ESC = /^(beta|bar|bf|big|Big|bigg|Bigg|binom|boldsymbol|bullet|frac|forall|theta|tau|text|textbf|textit|textrm|times|tilde|top|tfrac|to|nu|neq|nabla|not|rho|right|rangle|rightarrow|Rightarrow|rfloor|rceil)(?![A-Za-z])/;
export function fixJsonStrings(t: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (!inStr) {
      if (c === '"') inStr = true;
      out += c;
      continue;
    }
    if (c === '"') {
      inStr = false;
      out += c;
    } else if (c === "\\") {
      const nx = t[i + 1];
      if (nx === undefined) {
        out += c;
      } else if (nx === "\\" || nx === '"' || nx === "/") {
        out += c + nx;
        i++;
      } else if (nx === "u" && /^[0-9a-fA-F]{4}$/.test(t.slice(i + 2, i + 6))) {
        out += c;
      } else if ("bfnrt".includes(nx) && !LATEX_ON_VALID_ESC.test(t.slice(i + 1))) {
        out += c + nx;
        i++;
      } else {
        out += "\\\\"; // LaTeX 명령 또는 잘못된 이스케이프 → 글자 그대로의 역슬래시
      }
    } else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else out += c;
  }
  return out;
}

function normalizeSummary(obj: unknown): Partial<PaperSummary> | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const out: Partial<PaperSummary> = {};
  let hit = 0;
  for (const k of STR_FIELDS) {
    const v = o[k];
    const s = typeof v === "string" ? v.trim() : Array.isArray(v) ? v.map(asStr).filter(Boolean).map((x) => `- ${x}`).join("\n") : "";
    if (s) {
      out[k] = s;
      hit++;
    }
  }
  for (const k of LIST_FIELDS) {
    const v = o[k];
    const arr = Array.isArray(v) ? v.map(asStr).filter(Boolean) : typeof v === "string" && v.trim() ? [v.trim()] : [];
    if (arr.length) {
      out[k] = arr;
      hit++;
    }
  }
  return hit ? out : null;
}

function asStr(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).map(asStr).filter(Boolean).join(" — ");
  return "";
}

/**
 * 출력 한도에서 잘린 JSON 살리기(segment.ts salvageObjects 와 같은 발상 — 문자열 안 괄호·이스케이프를 센다).
 * 끝에서 열린 문자열·괄호를 닫아 보고, 안 되면 최상위/배열 안의 마지막 쉼표까지 잘라 닫는다.
 */
export function repairJson(t: string): unknown {
  const stack: string[] = [];
  const cuts: { pos: number; closers: string }[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") {
      stack.pop();
      if (!stack.length) return tryParse(t.slice(0, i + 1)); // 첫 최상위 객체가 닫혔다 — 뒤는 잡음
    } else if (c === ",") cuts.push({ pos: i, closers: [...stack].reverse().join("") });
  }
  const closers = [...stack].reverse().join("");
  const tail = t.replace(/(^|[^\\])((?:\\\\)*)\\$/, "$1$2"); // 홀수 개 역슬래시로 끝나면 잘린 이스케이프
  const candidates = [inStr ? `${tail}"${closers}` : `${tail}${closers}`];
  for (let k = cuts.length - 1; k >= 0; k--) candidates.push(t.slice(0, cuts[k].pos) + cuts[k].closers);
  for (const c of candidates) {
    const v = tryParse(c);
    if (v && typeof v === "object") return v;
  }
  return null;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ── 이미지 헤더 ──────────────────────────────────────────────────────
export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export const IMAGE_EXT: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** 매직 바이트로 실제 형식과 크기를 읽는다. 렌더러가 준 mime 을 믿지 않는다(이미지가 아닌 바이트를 저장하지 않게). */
export function sniffImage(buf: Uint8Array): { mime: ImageMime; w?: number; h?: number } | null {
  const u8 = buf;
  const n = u8.length;
  const be16 = (o: number) => (u8[o] << 8) | u8[o + 1];
  const be32 = (o: number) => ((u8[o] << 24) >>> 0) + (u8[o + 1] << 16) + (u8[o + 2] << 8) + u8[o + 3];
  const le16 = (o: number) => u8[o] | (u8[o + 1] << 8);
  const le24 = (o: number) => u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16);
  if (n >= 24 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    return { mime: "image/png", w: be32(16), h: be32(20) };
  }
  if (n >= 10 && u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) {
    return { mime: "image/gif", w: le16(6), h: le16(8) };
  }
  if (n >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) {
    const kind = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
    if (kind === "VP8 " && n >= 30) return { mime: "image/webp", w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (kind === "VP8L" && n >= 25) {
      const b = u8[21] | (u8[22] << 8) | (u8[23] << 16) | (u8[24] << 24);
      return { mime: "image/webp", w: (b & 0x3fff) + 1, h: ((b >>> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X" && n >= 30) return { mime: "image/webp", w: le24(24) + 1, h: le24(27) + 1 };
    return { mime: "image/webp" };
  }
  if (n >= 4 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) {
    // SOFn 마커를 찾는다(DHT·DAC 는 SOF 가 아니다)
    let o = 2;
    while (o + 9 < n) {
      if (u8[o] !== 0xff) { o++; continue; }
      const marker = u8[o + 1];
      if (marker === 0xff) { o++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      const len = be16(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: "image/jpeg", h: be16(o + 5), w: be16(o + 7) };
      }
      if (len < 2) break;
      o += 2 + len;
    }
    return { mime: "image/jpeg" };
  }
  return null;
}
