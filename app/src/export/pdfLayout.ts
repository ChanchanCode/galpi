// One geometry contract for the preview, Chromium print, and original PDF overlay (points).
export interface PdfExportSettings {
  paper: "a3" | "a4";
  translationPercent: number;
  fontSize: number;
  fitSmallOverflow: boolean; // Only reduce this source page's font, by at most 10%.
  lineHeight: number;
  fontFamily: string; // Empty means the reader's current translation font.
  paragraphSpacing: number; // em
  outerMargin: number; // mm, around both columns
  columnGap: number; // mm, between the original page and translation
  paddingTop: number; // mm, inside the translation column
  paddingBottom: number; // mm
  paddingHorizontal: number; // mm, on each side
}

export const DEFAULT_PDF_SETTINGS: PdfExportSettings = {
  paper: "a3", translationPercent: 50, fontSize: 11.5, fitSmallOverflow: true, lineHeight: 1.7,
  fontFamily: '"Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
  paragraphSpacing: 0.7, outerMargin: 8, columnGap: 6,
  paddingTop: 6, paddingBottom: 6, paddingHorizontal: 4,
};

export function normalizePdfSettings(raw: Partial<PdfExportSettings> | null | undefined): PdfExportSettings {
  const bounded = (n: unknown, fallback: number, min: number, max: number) =>
    typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  return {
    paper: raw?.paper === "a4" ? "a4" : "a3",
    translationPercent: bounded(raw?.translationPercent, 50, 25, 65),
    fontSize: bounded(raw?.fontSize, 11.5, 8, 20),
    fitSmallOverflow: raw?.fitSmallOverflow !== false,
    lineHeight: bounded(raw?.lineHeight, 1.7, 1.2, 2.6),
    fontFamily: typeof raw?.fontFamily === "string" ? raw.fontFamily.replace(/[;{}<>\n\r]/g, "").slice(0, 250) : DEFAULT_PDF_SETTINGS.fontFamily,
    paragraphSpacing: bounded(raw?.paragraphSpacing, 0.7, 0, 2),
    outerMargin: bounded(raw?.outerMargin, 8, 4, 20),
    columnGap: bounded(raw?.columnGap, 6, 2, 20),
    paddingTop: bounded(raw?.paddingTop, 6, 0, 40),
    paddingBottom: bounded(raw?.paddingBottom, 6, 0, 40),
    paddingHorizontal: bounded(raw?.paddingHorizontal, 4, 0, 20),
  };
}

export function pdfGeometry(settings: PdfExportSettings) {
  const mm = 72 / 25.4;
  const width = (settings.paper === "a3" ? 420 : 297) * mm;
  const height = (settings.paper === "a3" ? 297 : 210) * mm;
  const margin = settings.outerMargin * mm;
  const top = margin + 18;
  const bottom = margin + 14;
  const gap = settings.columnGap * mm;
  const columns = width - margin * 2 - gap;
  const translationWidth = columns * settings.translationPercent / 100;
  return { width, height, margin, top, bottom, gap,
    sourceWidth: columns - translationWidth, translationWidth, bodyHeight: height - top - bottom };
}

export function fitSourcePage(settings: PdfExportSettings, width: number, height: number) {
  const g = pdfGeometry(settings);
  const scale = Math.min(g.sourceWidth / width, g.bodyHeight / height);
  // Keep the original page next to the translation and aligned to the top.
  // Centering in a wide column otherwise turns unused width into a large gutter.
  return { x: g.margin + g.sourceWidth - width * scale,
    y: g.top,
    width: width * scale, height: height * scale, scale };
}
