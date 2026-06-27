// 읽기 보조 변환 — Bionic Reading(단어 앞부분 굵게) + 문장 끝 강제 줄바꿈.
// 둘 다 전역 토글(ReadingContext)로 켜고, RichText 의 평문 조각에만 적용한다.
import { createContext, Fragment, type ReactNode } from "react";

export interface ReadingOpts {
  bionic: boolean;
  sentenceBreak: boolean;
}
export const ReadingContext = createContext<ReadingOpts>({ bionic: false, sentenceBreak: false });

// ── Bionic: 단어 앞부분 굵게 ──────────────────────────────────────
function boldLen(len: number): number {
  if (len <= 1) return len;
  if (len <= 3) return 1;
  if (len <= 6) return 2;
  return Math.ceil(len * 0.4);
}

export function bionicNodes(text: string, keyBase: string): ReactNode[] {
  const parts = text.match(/[\p{L}\p{N}]+|[^\p{L}\p{N}]+/gu);
  if (!parts) return [text];
  const out: ReactNode[] = [];
  let i = 0;
  for (const part of parts) {
    if (/[\p{L}\p{N}]/u.test(part[0])) {
      const n = boldLen(part.length);
      out.push(
        <b key={`${keyBase}b${i++}`} className="bionic">
          {part.slice(0, n)}
        </b>,
      );
      if (n < part.length) out.push(part.slice(n));
    } else {
      out.push(part);
    }
  }
  return out;
}

// ── 문장 경계 분할 (보수적 — 과분할 방지) ─────────────────────────
// 약어/소수점/이니셜은 끊지 않고, "다음이 (공백) +대문자/숫자/여는기호"일 때만 문장 끝으로 본다.
// 공백은 선택(\s*): '문장 줄바꿈'으로 렌더된 본문은 문장 사이 공백이 제거되어 붙어 있으므로
// (예: "conducted.Scientists") 공백 없이도 경계를 잡아야 포커스 '문장' 모드가 동작한다.
const ABBR = new Set([
  "e.g", "i.e", "cf", "vs", "fig", "figs", "eq", "eqs", "tab", "sec", "secs", "no", "nos", "al",
  "dr", "mr", "mrs", "ms", "prof", "vol", "pp", "ch", "approx", "resp", "ca", "viz", "etc",
  "st", "inc", "ltd", "co", "jr", "sr", "ed", "eds", "cor", "prop", "thm", "def", "lem",
]);

export function splitSentences(text: string): string[] {
  const res: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "." && c !== "?" && c !== "!") continue;
    // 닫는 따옴표/괄호는 문장에 포함
    let j = i + 1;
    while (j < text.length && /[)\]"'’”]/.test(text[j])) j++;
    const rest = text.slice(j);
    const ends = j >= text.length || /^\s*[A-Z([“"'\d]/.test(rest);
    if (!ends) continue;
    if (c === ".") {
      // 소수점 (숫자.숫자) / 약어 / 단일 이니셜은 제외
      if (/\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) continue;
      const before = text.slice(start, i);
      const mw = before.match(/(\S+)$/);
      const wordRaw = mw ? mw[1] : "";
      const word = wordRaw.replace(/^[("'“[]+/, "").toLowerCase();
      if (ABBR.has(word)) continue;
      if (/^[A-Za-z]$/.test(wordRaw)) continue; // "J." 이니셜
    }
    let k = j;
    while (k < text.length && /\s/.test(text[k])) k++; // 뒤 공백 흡수
    res.push(text.slice(start, k));
    start = k;
    i = k - 1;
  }
  if (start < text.length) res.push(text.slice(start));
  return res;
}

// 평문 조각에 읽기 보조 적용(문장 줄바꿈 → 각 문장 내부 Bionic).
export function renderReading(text: string, opts: ReadingOpts, keyBase: string): ReactNode[] {
  if (!opts.bionic && !opts.sentenceBreak) return [text];
  if (!opts.sentenceBreak) return bionicNodes(text, keyBase);

  const sents = splitSentences(text);
  const out: ReactNode[] = [];
  sents.forEach((s, i) => {
    const isLast = i === sents.length - 1;
    const content = isLast ? s : s.replace(/\s+$/, "");
    out.push(
      <Fragment key={`${keyBase}s${i}`}>
        {opts.bionic ? bionicNodes(content, `${keyBase}s${i}`) : content}
      </Fragment>,
    );
    if (!isLast) out.push(<br key={`${keyBase}br${i}`} />);
  });
  return out;
}
