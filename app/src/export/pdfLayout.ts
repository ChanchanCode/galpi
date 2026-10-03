// One geometry contract for the preview, Chromium print, and original PDF overlay (points).
export interface PdfExportSettings {
  paper: "a3" | "a4";
  translationPercent: number;
  fontSize: number;
  lineHeight: number;
  paddingTop: number; // mm, inside the translation column
  paddingBottom: number; // mm
  paddingHorizontal: number; // mm, on each side
}

export const DEFAULT_PDF_SETTINGS: PdfExportSettings = {
  paper: "a3", translationPercent: 40, fontSize: 11, lineHeight: 1.7,
  paddingTop: 12, paddingBottom: 8, paddingHorizontal: 4,
};

export function normalizePdfSettings(raw: Partial<PdfExportSettings> | null | undefined): PdfExportSettings {
  const bounded = (n: unknown, fallback: number, min: number, max: number) =>
    typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  return {
    paper: raw?.paper === "a4" ? "a4" : "a3",
    translationPercent: bounded(raw?.translationPercent, 40, 25, 65),
    fontSize: bounded(raw?.fontSize, 11, 8, 20),
    lineHeight: bounded(raw?.lineHeight, 1.7, 1.2, 2.6),
    paddingTop: bounded(raw?.paddingTop, 12, 0, 40),
    paddingBottom: bounded(raw?.paddingBottom, 8, 0, 40),
    paddingHorizontal: bounded(raw?.paddingHorizontal, 4, 0, 20),
  };
}

export function pdfGeometry(settings: PdfExportSettings) {
  const mm = 72 / 25.4;
  const width = (settings.paper === "a3" ? 420 : 297) * mm;
  const height = (settings.paper === "a3" ? 297 : 210) * mm;
  const margin = 24;
  const top = 48;
  const bottom = 36;
  const gap = 20;
  const columns = width - margin * 2 - gap;
  const translationWidth = columns * settings.translationPercent / 100;
  return { width, height, margin, top, bottom, gap,
    sourceWidth: columns - translationWidth, translationWidth, bodyHeight: height - top - bottom };
}

export function fitSourcePage(settings: PdfExportSettings, width: number, height: number) {
  const g = pdfGeometry(settings);
  const scale = Math.min(g.sourceWidth / width, g.bodyHeight / height);
  return { x: g.margin + (g.sourceWidth - width * scale) / 2,
    y: g.top + (g.bodyHeight - height * scale) / 2,
    width: width * scale, height: height * scale, scale };
}
