// 문장 정렬 번역의 코어 (PLAN-AI §5).
//
// 왜 한 파일에 마스킹·복원·앵커를 다 넣었나:
//   마스킹이 텍스트를 바꾸면 모델이 돌려주는 en 조각은 **마스킹된 텍스트**의 부분문자열이다.
//   앵커를 원문에 대고 찾으면 안 맞는다. 인덱스 매핑을 같은 자료구조 안에서 들고 있어야
//   "AI 가 돌려준 인용문이 원문과 안 맞아 앵커가 깨지는" 사고가 안 난다.
//
// 흐름: prepare(원문) → 모델에 masked 전달 → resolve(응답, prepared) → 원문 좌표의 span[]

// ── 마스킹 ────────────────────────────────────────────────────────────
// 수식은 한 글자만 틀어져도 KaTeX 가 깨진다. 센티넬로 빼 두면 모델이 손댈 여지가 없다.
// 센티넬은 ⟦…⟧ — 라틴/한글 어느 토크나이저에서도 쪼개지지만 **번역되지는 않는** 기호다.
const MASK_OPEN = "⟦";
const MASK_CLOSE = "⟧";

export interface MaskRule {
  name: string;
  re: RegExp; // 반드시 global
}

// 순서가 중요하다: 긴 것($$)을 먼저 잡아야 짧은 것($)이 안쪽을 물지 않는다.
//
// ⚠️ inline 패턴은 **파이프라인·렌더러와 글자 그대로 같아야 한다.**
//    pipeline/build_document.py:38 `_INLINE_MATH` 와 app/src/render/RichText.tsx:16 `TOKEN` 이
//    `(?<!\\)\$(.+?)(?<!\\)\$` 를 쓴다. 이스케이프된 \$ 를 인식 못 하는 패턴을 쓰면
//    실데이터에서 산문을 수식으로 오인해 마스킹이 통째로 밀린다.
//    실측(fama1992 b0125, "\$1 million" 포함):
//      틀린 규칙 → `$1 million) and toward stocks with relatively high book-to-market ratios (Table ` 을 수식으로 마스킹
//      바른 규칙 → `$\ln(\text{BE/ME})$` 등 진짜 수식 3개만
export const DEFAULT_MASK_RULES: MaskRule[] = [
  { name: "display", re: /\$\$[\s\S]+?\$\$/g },
  { name: "bracket", re: /\\\[[\s\S]+?\\\]/g },
  { name: "inline", re: /(?<!\\)\$.+?(?<!\\)\$/g },
  { name: "paren", re: /\\\([\s\S]+?\\\)/g },
];

// 마스킹 규칙을 바꾸면 같은 원문이라도 모델이 보는 텍스트가 달라진다.
// **캐시 키에 이 버전을 넣어야** 규칙 수정 뒤 옛 번역이 잘못된 마스킹 위에 남지 않는다.
export const MASK_RULES_VERSION = "mask-2";

interface Piece {
  mStart: number; // 마스킹 텍스트에서의 시작
  mEnd: number;
  oStart: number; // 원문에서의 시작
  oEnd: number;
  masked: boolean;
}

export interface Prepared {
  original: string;
  text: string; // 모델에게 줄 텍스트(마스킹됨). 마스킹 안 하면 original 과 같다.
  tokens: string[]; // 센티넬 index → 원문 조각
  pieces: Piece[];
}

export function prepare(original: string, rules: MaskRule[] | null = DEFAULT_MASK_RULES): Prepared {
  if (!rules || !rules.length) {
    return {
      original,
      text: original,
      tokens: [],
      pieces: [{ mStart: 0, mEnd: original.length, oStart: 0, oEnd: original.length, masked: false }],
    };
  }
  // 모든 규칙의 매치를 모아 겹치지 않게 정리
  const hits: { start: number; end: number }[] = [];
  for (const r of rules) {
    r.re.lastIndex = 0;
    for (let m = r.re.exec(original); m; m = r.re.exec(original)) {
      const start = m.index;
      const end = start + m[0].length;
      if (hits.some((h) => start < h.end && end > h.start)) continue; // 겹치면 먼저 잡은 쪽 유지
      hits.push({ start, end });
    }
  }
  hits.sort((a, b) => a.start - b.start);

  const tokens: string[] = [];
  const pieces: Piece[] = [];
  let out = "";
  let cursor = 0;
  for (const h of hits) {
    if (h.start > cursor) {
      const seg = original.slice(cursor, h.start);
      pieces.push({ mStart: out.length, mEnd: out.length + seg.length, oStart: cursor, oEnd: h.start, masked: false });
      out += seg;
    }
    const idx = tokens.length;
    tokens.push(original.slice(h.start, h.end));
    const sentinel = `${MASK_OPEN}${idx}${MASK_CLOSE}`;
    pieces.push({ mStart: out.length, mEnd: out.length + sentinel.length, oStart: h.start, oEnd: h.end, masked: true });
    out += sentinel;
    cursor = h.end;
  }
  if (cursor < original.length) {
    const seg = original.slice(cursor);
    pieces.push({ mStart: out.length, mEnd: out.length + seg.length, oStart: cursor, oEnd: original.length, masked: false });
    out += seg;
  }
  if (!pieces.length) pieces.push({ mStart: 0, mEnd: 0, oStart: 0, oEnd: 0, masked: false });
  return { original, text: out, tokens, pieces };
}

// 센티넬을 원문 조각으로 되돌린다. 모델이 센티넬을 건드렸으면 그 자리는 그대로 남는다
// (그래서 verifyRestore 로 확인한다).
export function restore(p: Prepared, s: string): string {
  if (!p.tokens.length) return s;
  return s.replace(new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, "g"), (whole, d) => {
    const i = Number(d);
    return i >= 0 && i < p.tokens.length ? p.tokens[i] : whole;
  });
}

// 모델이 센티넬을 전부 온전히 돌려줬는가. 하나라도 잃으면 수식이 사라진 것이다.
export function verifyRestore(p: Prepared, s: string): { ok: boolean; missing: number[] } {
  const seen = new Set<number>();
  for (const m of s.matchAll(new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, "g"))) seen.add(Number(m[1]));
  const missing = p.tokens.map((_, i) => i).filter((i) => !seen.has(i));
  return { ok: missing.length === 0, missing };
}

// 마스킹 텍스트 인덱스 → 원문 인덱스. 마스킹 조각 안쪽이면 그 조각의 경계로 스냅한다.
//
// 경계 처리가 이 함수의 전부다. 조각 범위를 양끝 포함으로 보면 경계 인덱스가 **두 조각에 속해**
// 앞 조각이 먼저 걸린다 → 수식 바로 뒤 문장의 시작 좌표가 그 수식 안으로 밀린다.
// (테스트 "인덱스 매핑" 이 실제로 이걸 잡았다: elsevier b0022 에서 원문 '$' 자리를 가리켰다.)
// 그래서 start 는 [mStart, mEnd), end 는 (mStart, mEnd] 반열린 구간으로 본다.
export function toOriginal(p: Prepared, mIdx: number, side: "start" | "end" = "start"): number {
  if (mIdx <= 0) return 0;
  if (mIdx >= p.text.length) return p.original.length;
  for (const pc of p.pieces) {
    const inside = side === "start" ? mIdx >= pc.mStart && mIdx < pc.mEnd : mIdx > pc.mStart && mIdx <= pc.mEnd;
    if (!inside) continue;
    if (pc.masked) return side === "start" ? pc.oStart : pc.oEnd;
    return pc.oStart + (mIdx - pc.mStart);
  }
  return side === "start" ? 0 : p.original.length;
}

// ── 앵커 되짚기 ───────────────────────────────────────────────────────
// 모델은 en 조각을 "글자 그대로" 잘라 오라고 지시받지만, 공백·줄바꿈은 흔히 어긋난다.
// 그래서 공백을 \s+ 로 느슨하게 매칭한다(검증 시 커버리지 99.5%).
function looseRegex(needle: string): RegExp {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = esc.replace(/\s+/g, "\\s+");
  return new RegExp(body, "g");
}

function looseFind(hay: string, needle: string, from: number): [number, number] | null {
  const n = needle.trim();
  if (!n) return null;
  const re = looseRegex(n);
  re.lastIndex = from;
  const m = re.exec(hay);
  if (m) return [m.index, m.index + m[0].length];
  // 앞에서 못 찾으면 처음부터 한 번 더 — 모델이 순서를 바꿨을 수 있다
  re.lastIndex = 0;
  const m2 = re.exec(hay);
  return m2 ? [m2.index, m2.index + m2[0].length] : null;
}

// 모델 응답 한 블록분
export interface RawSeg {
  en?: string[];
  ko?: string;
}
export interface RawBlockResult {
  id?: string;
  seg?: RawSeg[];
  ko?: string; // 정렬 없이 통짜로 온 경우
}

// 최종 산출 — 원문 좌표의 문장 span 과 대응 한국어
export interface Span {
  start: number; // 원문 인덱스
  end: number;
  ko: string;
  ok: boolean; // 앵커를 실제로 찾았는가
}
export interface Resolved {
  id: string;
  ko: string; // 번역 전문(문장 이어붙임)
  spans: Span[];
  coverage: number; // 원문 글자 중 앵커가 덮은 비율 0~1
  latexOk: boolean;
}

// anchorMode:
//   "full"   — en 이 문장 전체(§5 검증본). 되돌려받는 양이 많아 출력 비용이 ~1.7배.
//   "prefix" — en 이 문장 앞 몇 단어만. 끝 좌표는 **다음 앵커의 시작**으로 잡는다.
//              출력이 크게 줄어 비용 1.1배 (§5 최적화 후보).
export type AnchorMode = "full" | "prefix";

// **여기가 마스킹·복원·앵커를 한 데 묶는 지점이다.**
export function resolve(prepared: Prepared, raw: RawBlockResult, id: string, mode: AnchorMode = "full"): Resolved {
  const hay = prepared.text; // 모델이 본 텍스트 = 마스킹된 것
  const segs = Array.isArray(raw.seg) ? raw.seg : [];
  const spans: Span[] = [];
  let cursor = 0;
  let covered = 0;
  let latexOk = true;

  // 1) 각 seg 의 앵커를 마스킹 좌표에서 찾는다
  const hits: ({ ms: number; me: number } | null)[] = [];
  for (const s of segs) {
    const enJoined = joinEn(s.en);
    const found = enJoined ? looseFind(hay, enJoined, cursor) : null;
    if (found) {
      cursor = found[1];
      hits.push({ ms: found[0], me: found[1] });
    } else {
      hits.push(null);
    }
  }

  // 2) prefix 모드면 끝 좌표를 다음 앵커의 시작까지 늘린다
  for (let i = 0; i < segs.length; i++) {
    const ko = restore(prepared, String(segs[i].ko ?? ""));
    const h = hits[i];
    if (!h) {
      spans.push({ start: -1, end: -1, ko, ok: false });
      continue;
    }
    let me = h.me;
    if (mode === "prefix") {
      let next = hay.length;
      for (let j = i + 1; j < hits.length; j++) {
        const hj = hits[j];
        if (hj && hj.ms > h.ms) { next = hj.ms; break; }
      }
      me = Math.max(h.me, next);
    }
    const start = toOriginal(prepared, h.ms, "start");
    const end = toOriginal(prepared, me, "end");
    covered += Math.max(0, end - start);
    spans.push({ start, end, ko, ok: true });
  }

  const ko = spans.map((s) => s.ko).join(" ").trim() || restore(prepared, String(raw.ko ?? ""));
  if (prepared.tokens.length) latexOk = verifyRestore(prepared, segs.map((s) => String(s.ko ?? "")).join(" ")).ok;

  return {
    id,
    ko,
    spans,
    coverage: prepared.original.length ? Math.min(1, covered / prepared.original.length) : 0,
    latexOk,
  };
}

function joinEn(en: unknown): string {
  if (!Array.isArray(en)) return typeof en === "string" ? en : "";
  return en.map((x) => String(x ?? "")).join(" ").trim();
}

// 모델 응답(JSON 문자열)에서 배열을 꺼낸다. 코드펜스·머리말을 관대하게 벗긴다.
export function parseBlocksJson(text: string): RawBlockResult[] {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const first = t.indexOf("[");
  const last = t.lastIndexOf("]");
  // 잘린 응답에서는 마지막 ']' 가 배열이 아니라 안쪽 seg 배열의 것이다 —
  // 여기서 자르면 바깥 객체의 '}' 까지 날아가 건질 게 줄어든다. 원본을 따로 남긴다.
  const raw = t;
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  try {
    const j = JSON.parse(t);
    if (!Array.isArray(j)) throw new Error("배열이 아님");
    return j as RawBlockResult[];
  } catch (err) {
    // 배치가 크면 응답이 출력 한도에서 잘려 배열이 안 닫힌다. 통째로 버리면 그 배치의
    // 블록이 **전부** 날아가므로, 온전히 닫힌 객체만 건져 낸다(실측: 26배치 중 1개 실패 → 5블록 손실).
    const salvaged = salvageObjects(raw);
    if (salvaged.length) return salvaged;
    throw err;
  }
}

// 최상위 배열 안에서 균형 잡힌 { … } 만 골라 파싱한다. 문자열 안의 중괄호·이스케이프를 센다.
function salvageObjects(t: string): RawBlockResult[] {
  const out: RawBlockResult[] = [];
  let depth = 0;
  let start = -1;
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
    else if (c === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(t.slice(start, i + 1)) as RawBlockResult);
        } catch {
          /* 이 조각은 버린다 */
        }
        start = -1;
      }
    }
  }
  return out;
}
