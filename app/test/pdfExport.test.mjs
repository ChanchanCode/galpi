import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { choosePdfPageFont } from "../src/export/pdfFit.js";

await build({ entryPoints: ["electron/pdfCompose.ts"], outfile: "dist-test/pdfCompose.cjs",
  bundle: true, platform: "node", format: "cjs" });
await build({ entryPoints: ["src/export/pdfLayout.ts"], outfile: "dist-test/pdfLayout.cjs",
  bundle: true, platform: "node", format: "cjs" });
await build({ entryPoints: ["src/export/pdfFilename.ts"], outfile: "dist-test/pdfFilename.cjs",
  bundle: true, platform: "node", format: "cjs" });
const require = createRequire(import.meta.url);
const { overlaySourcePdf } = require("../dist-test/pdfCompose.cjs");
const { normalizePdfSettings, pdfGeometry, fitSourcePage } = require("../dist-test/pdfLayout.cjs");
const settings = normalizePdfSettings({});
const { bilingualPdfFilename, documentYear, documentAuthors } = require("../dist-test/pdfFilename.cjs");

test("Small overflows shrink only the affected font within 10%; large overflows keep readable typography", () => {
  const config = structuredClone(settings);
  assert.equal(choosePdfPageFont(config, () => true), 11.5);
  assert.equal(choosePdfPageFont(config, (font) => font <= 11.1), 11.1);
  assert.equal(choosePdfPageFont(config, (font) => font <= 10), 11.5);
  assert.equal(choosePdfPageFont({ ...config, fitSmallOverflow: false }, (font) => font <= 11.1), 11.5);
  assert.equal(choosePdfPageFont({ ...config, fontSize: 8 }, () => false), 8);
  assert.equal(choosePdfPageFont({ ...config, fontSize: 8.5 }, (font) => font <= 8), 8);
  assert.deepEqual(config, settings);
});

test("Export names use authors, a verified document year and a clean title", () => {
  const doc = {doc_id:"paper",title:"Do ETFs Increase Volatility?",authors:"ITZHAK BEN-DAVID, FRANCESCO FRANZONI, and RABIH MOUSSAWI"};
  const evidence = {headerLines:["THE JOURNAL OF FINANCE • VOL. LXXIII, NO. 6 • DECEMBER 2018"],pageText:"References from 1990 and 2015."};
  assert.equal(bilingualPdfFilename(doc,evidence),"Ben-David et al. (2018) - Do ETFs Increase Volatility - 원문+번역.pdf");
  assert.equal(documentYear({}, {coverLines:["(Received November 1995; final version July 1996)"],pageText:"© 1997 Elsevier Science"}),"1997");
  assert.equal(documentYear({}, {coverLines:["Our sample covers 2010–2023.","Lo and MacKinlay (1988)."]}),null);
  assert.equal(documentYear({}, {coverLines:["September 22, 2026"]}),"2026");
  assert.equal(documentYear({year:2019},evidence),"2019");
  assert.equal(documentAuthors("Brad M. Barber, John D. Lyon"),"Barber & Lyon");
  assert.equal(documentAuthors("Jangkoo Kang Wongi Lee September",["Jangkoo Kang†","Wongi Lee‡","September 22, 2026"]),"Kang & Lee");
  const long = bilingualPdfFilename({doc_id:"paper",title:"한글 제목 / 제목: ".repeat(80),authors:"김철수",year:2026});
  assert.ok(new TextEncoder().encode(long).length<=240);
  assert.ok(long.startsWith("김철수 (2026) - ") && long.endsWith(" - 원문+번역.pdf"));
  assert.ok(!/[\\/:*?"<>|]/.test(long));
  assert.match(bilingualPdfFilename({doc_id:"paper",title:null,authors:null}),/^저자 미상 \(연도 미상\)/);
});

test("Independent outer margin and gutter controls keep source pages next to the translation", () => {
  const config = normalizePdfSettings({ outerMargin: 15, columnGap: 12, translationPercent: 35 });
  const g = pdfGeometry(config);
  const fit = fitSourcePage(config, 432, 656);
  assert.ok(Math.abs(g.margin - 15 * 72 / 25.4) < 1e-9);
  assert.ok(Math.abs(g.gap - 12 * 72 / 25.4) < 1e-9);
  assert.ok(Math.abs(fit.x + fit.width - g.margin - g.sourceWidth) < 1e-9);
  assert.equal(fit.y, g.top);
  assert.equal(normalizePdfSettings({ fontSize: 18, lineHeight: 2.4, paddingTop: 24 }).fontSize, 18);
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
