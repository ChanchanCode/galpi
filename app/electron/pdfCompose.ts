import { PDFDocument, degrees } from "pdf-lib";
import { fitSourcePage, pdfGeometry, type PdfExportSettings } from "../src/export/pdfLayout";

// Preserves the actual original PDF contents, including text and vector diagrams.
export async function overlaySourcePdf(translation: Uint8Array, source: Uint8Array,
  pageMap: number[], settings: PdfExportSettings): Promise<Uint8Array> {
  const output = await PDFDocument.load(translation);
  const original = await PDFDocument.load(source);
  if (output.getPageCount() !== pageMap.length) throw new Error("미리보기와 PDF의 페이지 수가 다릅니다. 다시 미리보기를 열어 주세요.");
  const embedded = new Map<number, Awaited<ReturnType<PDFDocument["embedPage"]>>>();
  const g = pdfGeometry(settings);
  // Chromium rounds paper dimensions to hundredths of an inch. Keep the saved
  // MediaBox at the exact shared geometry; this trims only the unused edge.
  for (const page of output.getPages()) page.setSize(g.width, g.height);
  for (let i = 0; i < pageMap.length; i++) {
    const index = pageMap[i] - 1;
    if (!Number.isInteger(index) || index < 0 || index >= original.getPageCount()) throw new Error("원문 페이지 번호가 올바르지 않습니다.");
    const page = original.getPage(index);
    if (!page.node.Contents()) continue; // Truly blank original pages need no overlay.
    const box = page.getCropBox();
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    const swap = rotation === 90 || rotation === 270;
    const fit = fitSourcePage(settings, swap ? box.height : box.width, swap ? box.width : box.height);
    let art = embedded.get(index);
    if (!art) {
      art = await output.embedPage(page, { left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height });
      embedded.set(index, art);
    }
    let x = fit.x;
    let y = g.height - fit.y - fit.height;
    if (rotation === 90) y += box.width * fit.scale;
    else if (rotation === 180) { x += box.width * fit.scale; y += box.height * fit.scale; }
    else if (rotation === 270) x += box.height * fit.scale;
    output.getPage(i).drawPage(art, { x, y, xScale: fit.scale, yScale: fit.scale, rotate: degrees(-rotation) });
  }
  output.setProducer("Galpi");
  output.setCreator("Galpi · 원문 + 번역");
  return output.save();
}
