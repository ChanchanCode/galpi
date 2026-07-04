// 주석(형광펜 + 메모)을 Markdown 텍스트로 — 노트 앱(Notion/Obsidian 등)에 붙여넣는 용도.
// 본문 DOM 에서 첫 출현 위치를 찾아 문서 순서대로 정렬한다(읽은 흐름 그대로).
import { firstMatchRange, PALETTE, ruleScope, type HighlightRule } from "../highlight/highlights";
import { firstNoteRange, type Note } from "../notes/notes";

const CONTAINER_SEL = ".reader-content";

function sortByDocPosition<T>(items: T[], getRange: (t: T) => Range | null): T[] {
  return items
    .map((item) => ({ item, range: getRange(item) }))
    .sort((a, b) => {
      if (a.range && b.range) return a.range.compareBoundaryPoints(Range.START_TO_START, b.range);
      return a.range ? -1 : b.range ? 1 : 0; // 매칭 실패 항목은 뒤로
    })
    .map((x) => x.item);
}

export function buildAnnotationsMarkdown(
  title: string,
  highlights: HighlightRule[],
  notes: Note[],
): string {
  const container = document.querySelector(CONTAINER_SEL) as HTMLElement | null;
  const colorLabel = new Map(PALETTE.map((p) => [p.key, p.label]));
  const hl = sortByDocPosition(highlights, (r) => (container ? firstMatchRange(container, r) : null));
  const nt = sortByDocPosition(notes, (n) => (container ? firstNoteRange(container, n) : null));

  const lines: string[] = [`# ${title}`, ""];
  if (nt.length) {
    lines.push("## 메모", "");
    for (const n of nt) {
      lines.push(`> ${n.quote}`, "");
      if (n.body.trim()) lines.push(n.body.trim(), "");
    }
  }
  if (hl.length) {
    lines.push("## 형광펜", "");
    for (const r of hl) {
      const label = r.label ? ` — ${r.label}` : "";
      const kind = ruleScope(r) === "keyword" ? "·키워드" : "";
      lines.push(`- **${r.text}**${label} (${colorLabel.get(r.color) ?? r.color}${kind})`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
