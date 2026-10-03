import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { choosePdfFit } from "../src/export/pdfFit.js";

await build({ entryPoints: ["electron/pdfCompose.ts"], outfile: "dist-test/pdfCompose.cjs",
  bundle: true, platform: "node", format: "cjs" });
await build({ entryPoints: ["src/export/pdfLayout.ts"], outfile: "dist-test/pdfLayout.cjs",
  bundle: true, platform: "node", format: "cjs" });
const require = createRequire(import.meta.url);
const { overlaySourcePdf } = require("../dist-test/pdfCompose.cjs");
const { normalizePdfSettings, pdfGeometry, fitSourcePage } = require("../dist-test/pdfLayout.cjs");
const settings = normalizePdfSettings({});

test("Automatic fitting tries typography, then padding, then continuation without changing defaults", () => {
  const saved = structuredClone(settings);
  const measure = (height) => (p) => height * (p.fontSize / settings.fontSize)
    * (p.lineHeight / settings.lineHeight) * (100 - settings.paddingHorizontal * 2) / (100 - p.paddingHorizontal * 2)
    <= 100 - p.paddingTop - p.paddingBottom;
  const fits = choosePdfFit(settings, measure(50));
  assert.equal(fits.stage, "none");
  assert.equal(fits.fontSize, settings.fontSize);
  const typography = choosePdfFit(settings, measure(140));
  assert.equal(typography.stage, "typography");
  assert.ok(typography.fontSize < settings.fontSize && typography.fontSize >= 8);
  assert.ok(typography.lineHeight < settings.lineHeight && typography.lineHeight >= 1.2);
  assert.equal(typography.paddingTop, settings.paddingTop);
  assert.equal(typography.paddingBottom, settings.paddingBottom);
  assert.equal(typography.paddingHorizontal, settings.paddingHorizontal);
  assert.ok(measure(140)(typography));
  const padding = choosePdfFit(settings, measure(180));
  assert.equal(padding.stage, "padding");
  assert.equal(padding.fontSize, 8);
  assert.equal(padding.lineHeight, 1.2);
  assert.ok(padding.paddingTop > 0 && padding.paddingTop < settings.paddingTop);
  assert.ok(measure(180)(padding));
  const overflow = choosePdfFit(settings, measure(500));
  assert.equal(overflow.stage, "overflow");
  assert.equal(overflow.fontSize, 8);
  assert.equal(overflow.lineHeight, 1.2);
  assert.equal(overflow.paddingTop + overflow.paddingBottom + overflow.paddingHorizontal, 0);
  assert.deepEqual(settings, saved);
});

test("PDF settings reject non-finite saved values; source fits either paper without distortion", () => {
  assert.deepEqual(normalizePdfSettings({ paper: "bad", fontSize: NaN, lineHeight: Infinity, translationPercent: -2 }),
    { ...settings, translationPercent: 25 });
  assert.deepEqual(normalizePdfSettings({ paddingTop: -3, paddingBottom: NaN, paddingHorizontal: 99 }),
    { ...settings, paddingTop: 0, paddingHorizontal: 20 });
  for (const paper of ["a3", "a4"]) {
    const config = { ...settings, paper, translationPercent: 65 };
    const g = pdfGeometry(config);
    const fit = fitSourcePage(config, 612, 792);
    assert.ok(fit.x >= g.margin);
    assert.ok(fit.y >= g.top);
    assert.ok(fit.width <= g.sourceWidth + 0.001);
    assert.ok(fit.height <= g.bodyHeight + 0.001);
    assert.ok(Math.abs(fit.width / fit.height - 612 / 792) < 1e-9);
  }
});

test("Original vector pages survive continuation repeats, cropped pages and rotations", async () => {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  for (const angle of [0, 90, 180, 270]) {
    const page = source.addPage([612, 792]);
    page.setCropBox(20, 30, 572, 732);
    page.setRotation(degrees(angle));
    page.drawText(`Original ${angle}`, { x: 45, y: 700, font, size: 18 });
  }
  source.addPage([612, 792]); // A real blank page has no /Contents stream.
  const base = await PDFDocument.create();
  const g = pdfGeometry(settings);
  const map = [1, 1, 2, 3, 4, 5];
  map.forEach(() => base.addPage([g.width, g.height]));
  const output = await PDFDocument.load(await overlaySourcePdf(await base.save(), await source.save(), map, settings));
  assert.equal(output.getPageCount(), 6);
  for (const page of output.getPages().slice(0, 5)) {
    assert.equal(page.getWidth(), g.width);
    assert.ok(page.node.Contents());
    assert.ok(page.node.Resources());
  }
  await assert.rejects(overlaySourcePdf(await base.save(), await source.save(), [1], settings), /페이지 수/);
  await assert.rejects(overlaySourcePdf(await base.save(), await source.save(), [1, 1, 2, 3, 4, 99], settings), /페이지 번호/);
});
