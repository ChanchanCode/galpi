// 논문 앞부분(article-info 사이드바: 투고이력/JEL/키워드)을 감지해 접이식으로 묶는다.
// Elsevier 류는 제목·저자·소속 다음에 'article info' 박스가 길게 펼쳐져 읽기 흐름을 해친다.
import type { Block } from "../types";

const stripSpaces = (s: string) => s.replace(/\s+/g, "").toLowerCase();

// "a b s t r a c t" / "a r t i c l e i n f o" 처럼 글자마다 띈 장식 라벨인가
export function isSpacedLabel(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length > 40) return false;
  const toks = t.split(/\s+/);
  const singles = toks.filter((x) => x.length === 1).length;
  return toks.length >= 4 && singles / toks.length >= 0.7;
}

// "a r t i c l e i n f o" 처럼 글자마다 띈 라벨 → "article info" 식으로 복원(표시용)
export function deSpaceLabel(text: string): string {
  const toks = text.trim().split(/\s+/);
  const singles = toks.filter((t) => t.length === 1).length;
  if (toks.length >= 4 && singles / toks.length >= 0.7) {
    // 알파벳 단일문자 연속을 한 단어로(공백 정보 소실되나 라벨이라 무방)
    return text.replace(/(?:\b\w\s){2,}\w\b/g, (m) => m.replace(/\s+/g, ""));
  }
  return text;
}

export interface FrontMatter {
  ids: Set<string>; // 본문 흐름에서 빼서 접이식에 넣을 블록 id
  items: Block[]; // 접이식 안에 순서대로 표시
  startId: string | null; // 이 블록 위치에 접이식을 끼워넣는다
}

export function buildFrontMatter(blocks: Block[]): FrontMatter {
  const isInfoStart = (b: Block) => {
    if (b.page > 2 || !b.text) return false;
    const sq = stripSpaces(b.text);
    return sq === "articleinfo" || /^article history|^jel ?classification/i.test(b.text.trim());
  };
  const start = blocks.findIndex(isInfoStart);
  if (start < 0) return { ids: new Set(), items: [], startId: null };

  // 끝: 초록 본문(긴 문단) 또는 섹션 제목 직전까지
  let end = blocks.length;
  for (let i = start + 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "heading") { end = i; break; }
    if (b.type === "paragraph" && (b.text?.length ?? 0) > 180) { end = i; break; }
    if (b.page > 2) { end = i; break; }
  }
  const slice = blocks.slice(start, end);
  const isLabel = (b: Block) => ["articleinfo", "abstract"].includes(stripSpaces(b.text ?? ""));
  const items = slice.filter((b) => !isLabel(b)); // 띄어진 라벨은 박스 안에서도 제외
  return { ids: new Set(slice.map((b) => b.id)), items, startId: slice[0]?.id ?? null };
}
