import fs from "node:fs/promises";
import path from "node:path";
import type { PaperDocument } from "../src/types";
import { parsePageText } from "../src/translate/textLayer";
import { recoverFootnoteSource } from "../src/render/footnoteSource";

export async function loadFootnoteDocument(docDir: string): Promise<PaperDocument> {
  const doc: PaperDocument = JSON.parse(await fs.readFile(path.join(docDir, "document.json"), "utf8"));
  const sources = await Promise.all(doc.pages.map(async (page) => {
    if (!page.text) return null;
    const file = path.resolve(docDir, page.text);
    if (!file.startsWith(path.resolve(docDir) + path.sep)) return null;
    try {
      const source = parsePageText(JSON.parse(await fs.readFile(file, "utf8")));
      return source ? [page.index, source] as const : null;
    } catch { return null; } // Scans/legacy documents may have no text layer.
  }));
  return recoverFootnoteSource(doc, new Map(sources.filter((source) => source !== null)));
}
