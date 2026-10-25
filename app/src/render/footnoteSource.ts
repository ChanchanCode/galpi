import type { Block, PaperDocument } from "../types";
import type { PageText, TextLine } from "../translate/textLayer";

const LABEL = /^(?:<sup>\s*(\d{1,3}|[*†‡∗])\s*<\/sup>|(\d{1,3}|[*†‡∗])[.)]?)\s+/i;
const finished = /[.?!]["'’”\])]*$/;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const letters = (s: string) => s.replace(/<[^>]+>/g, "").normalize("NFKC").toLowerCase().replace(/[^\p{L}]/gu, "");

function linesFor(block: Block, source: PageText): TextLine[] {
  if (!block.bbox) return [];
  const [x0, y0, x1, y1] = block.bbox;
  return source.lines.filter((line) => !line.r && line.y + line.h / 2 >= y0 - 2
    && line.y + line.h / 2 <= y1 + 2 && line.x < x1 && line.x + line.w > x0)
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

// Use the existing PDF text layer to repair lost labels and a continued note that
// MinerU called a paragraph. Never infer a label just from the numbering sequence.
// This is an in-memory view; the extracted document and source PDF stay untouched.
export function recoverFootnoteSource(doc: PaperDocument, sources: Map<number, PageText>): PaperDocument {
  const blocks = doc.blocks.map((block) => ({ ...block }));
  let previous: Block | undefined;
  for (const page of doc.pages) {
    const onPage = blocks.filter((b) => b.page === page.index);
    const source = sources.get(page.index);
    if (source) {
      for (const block of onPage) {
        if (block.type !== "footnote" || !block.text || !block.bbox) continue;
        const first = linesFor(block, source)[0];
        const match = first?.t.match(LABEL);
        if (!match) continue;
        const body = first.t.slice(match[0].length);
        // Geometry alone can select another column. Confirm the beginning too.
        if (letters(block.text).startsWith(letters(body).slice(0, 24))) block.footnote_label = match[1] ?? match[2];
      }
      if (previous?.footnote_label && previous.page === page.index - 1 && !finished.test(previous.text?.trim() ?? "")) {
        const notes = onPage.filter((b) => b.type === "footnote" && b.bbox);
        const bandTop = Math.min(...notes.map((b) => b.bbox![1]));
        const bodyLines = onPage.filter((b) => b.type === "paragraph" && b.bbox && b.bbox[1] < page.height_pt * .45)
          .flatMap((b) => linesFor(b, source)).filter((line) => line.t.length > 30);
        const bodyHeight = median(bodyLines.map((line) => line.h));
        for (const block of onPage) {
          if (block.type !== "paragraph" || !block.bbox || !block.text || !notes.length || !bodyHeight) continue;
          const lines = linesFor(block, source);
          const height = median(lines.map((line) => line.h));
          if (block.bbox[1] < page.height_pt * .45 || block.bbox[3] > bandTop + 2 || lines.length < 2
            || height >= bodyHeight * .84 || height <= 0) continue;
          // A caption above body text is not a footnote continuation.
          if (onPage.some((b) => b !== block && b.type === "paragraph" && b.bbox && b.bbox[1] > block.bbox![3])) continue;
          block.type = "footnote";
          block.footnote_label = previous.footnote_label;
        }
      }
    }
    const last = onPage.filter((b) => b.type === "footnote").at(-1);
    if (last) {
      const match = last.text?.match(LABEL);
      last.footnote_label ??= match ? match[1] ?? match[2] : undefined;
    }
    previous = last;
  }
  return { ...doc, blocks };
}
