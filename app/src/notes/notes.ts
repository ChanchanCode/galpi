// 메모(주석) — 특정 문장에 코멘트를 남긴다. 형광펜(§8)이 "같은 단어 전부"를 칠하는 것과 달리,
// 메모는 사용자가 선택한 그 구절 하나에 묶인다. 텍스트-앵커 방식이라 리플로우(타이포 변경)에도 유지된다.
// 본문에는 점선 밑줄(::highlight(note-mark))로 표시하고, 내용은 인덱스 패널에서 읽고 편집한다.
import { normalizeText } from "../highlight/highlights";

export interface Note {
  id: string;
  quote: string; // 선택한 원문(표시·앵커용 원본)
  anchor: string; // normalizeText(quote) — 매칭용(연속 공백 1개·trim)
  body: string; // 메모 내용
  created_at: string;
  updated_at: string;
}

export function newNoteId(): string {
  return "n_" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 앵커 텍스트 → 정규식. 공백은 \s+ 로(원문 개행/공백 차이 흡수), 대소문자 무시.
function anchorRegex(anchor: string): RegExp | null {
  const norm = normalizeText(anchor);
  if (norm.length < 2) return null;
  const pat = escapeRegExp(norm).replace(/\\?\s+/g, "\\s+");
  try {
    return new RegExp(pat, "iu");
  } catch {
    return null;
  }
}

// 노트 표식 등록 키(::highlight(note-mark) 와 일치). 모듈 전역으로 우리 키만 관리.
const NOTE_KEY = "note-mark";
let registered = false;

function isSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

// 주어진 Range 들을 점선 밑줄로 칠한다(호버 판정용으로 호출부가 Range 를 이미 갖고 있을 때).
export function paintNoteMarks(ranges: Range[]): void {
  if (!isSupported()) return;
  if (registered) {
    CSS.highlights.delete(NOTE_KEY);
    registered = false;
  }
  if (!ranges.length) return;
  CSS.highlights.set(NOTE_KEY, new Highlight(...ranges));
  registered = true;
}

// container 안에서 각 노트의 표시 Range 를 계산해 반환(없으면 제외). 표식 칠하기는 호출부에서.
export function noteRanges(container: HTMLElement, notes: Note[]): { note: Note; range: Range }[] {
  const out: { note: Note; range: Range }[] = [];
  for (const n of notes) {
    const r = firstNoteRange(container, n);
    if (r) out.push({ note: n, range: r });
  }
  return out;
}

export function clearNoteMarks(): void {
  if (!isSupported()) return;
  if (registered) {
    CSS.highlights.delete(NOTE_KEY);
    registered = false;
  }
}

// container 안에서 노트 앵커의 첫 출현 Range(패널/표식 점프용).
export function firstNoteRange(container: HTMLElement, note: Note): Range | null {
  const re = anchorRegex(note.anchor || note.quote);
  if (!re) return null;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!node.nodeValue?.trim() || !el) return NodeFilter.FILTER_REJECT;
      if (el.closest(".katex, .katex-display, script, style")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  // 단일 텍스트 노드 안에서만 매칭(형광펜과 동일한 한계 §8). 긴 인용은 노드 경계로 끊겨 못 찾을 수 있음.
  let node: Node | null;
  while ((node = walker.nextNode())) {
    re.lastIndex = 0;
    const m = re.exec(node.nodeValue!);
    if (m && m[0].length) {
      const range = document.createRange();
      try {
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        return range;
      } catch {
        return null;
      }
    }
  }
  return null;
}
