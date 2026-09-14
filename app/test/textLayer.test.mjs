// textLayer.ts 결정적 검증 — 줄 pt 좌표 → % 배치·scaleX·회전 중심·블록 매칭.
// 실행: npm test  (node:test 내장, 의존성 0)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TL = require(path.join(import.meta.dirname, "..", "dist-test", "textLayer.cjs"));

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
// 가짜 측정기: 글자당 기준 크기의 0.5em — 폭이 글자 수에 비례
const measure = (t) => t.length * TL.TL_MEASURE_PX * 0.5;

test("parsePageText — 깨진 줄은 버리고 쓸 줄이 없으면 null", () => {
  assert.equal(TL.parsePageText(null), null);
  assert.equal(TL.parsePageText({ w: 612, h: 792 }), null);
  assert.equal(TL.parsePageText({ w: 0, h: 792, lines: [{ x: 1, y: 1, w: 1, h: 1, t: "a" }] }), null);
  assert.equal(TL.parsePageText({ w: 612, h: 792, lines: [] }), null);
  const pt = TL.parsePageText({
    w: 612,
    h: 792,
    lines: [
      { x: 10, y: 20, w: 100, h: 12, t: "ok" },
      { x: 10, y: 20, w: 100, h: 12, t: "" },
      { x: NaN, y: 20, w: 100, h: 12, t: "nan" },
      { x: 10, y: 20, w: -1, h: 12, t: "neg" },
      { x: 10, y: 20, w: 100, h: 12, t: "tilt", r: 45 },
      { x: 10, y: 20, w: 100, h: 12, t: "up", r: 270 },
      "junk",
    ],
  });
  assert.deepEqual(pt.lines.map((l) => l.t), ["ok", "up"]);
  assert.equal(pt.lines[1].r, 270);
  assert.equal("r" in pt.lines[0], false);
});

test("placeLine — 위치는 쪽 비율, 글자 크기는 줄높이×0.85, scaleX 로 폭이 정확히 맞는다", () => {
  const page = { w: 612, h: 792 };
  const l = { x: 72, y: 100, w: 300, h: 12, t: "Estimating standard errors" };
  const p = TL.placeLine(l, page, measure);
  near(p.left, (72 / 612) * 100);
  near(p.top, (100 / 792) * 100);
  near(p.font, 12 * 0.85);
  const sx = Number(/scaleX\(([^)]+)\)/.exec(p.transform)[1]);
  assert.ok(!p.transform.includes("rotate"));
  // 렌더 폭 = 측정폭(기준) × font/기준 × scaleX = w  (반올림 1e-5 이내)
  near((measure(l.t) * p.font) / TL.TL_MEASURE_PX * sx, l.w, 1e-2);
});

test("줌·쪽 폭과 무관 — 렌더 폭(px) = w × pxPerPt", () => {
  const page = { w: 516, h: 720 };
  const l = { x: 40, y: 60, w: 410.5, h: 11.2, t: "abnormal returns around the event" };
  const p = TL.placeLine(l, page, measure);
  const sx = Number(/scaleX\(([^)]+)\)/.exec(p.transform)[1]);
  for (const renderedW of [240, 514, 1400]) {
    const s = TL.pxPerPt(renderedW, page.w);
    const fontPx = p.font * s; // CSS: calc(var(--tl-s) * font px)
    const widthPx = (measure(l.t) * fontPx) / TL.TL_MEASURE_PX * sx;
    near(widthPx, l.w * s, 1e-2);
    near((p.left / 100) * renderedW, l.x * s, 1e-9);
  }
  assert.equal(TL.pxPerPt(0, 612), 1);
});

test("fitScaleX — 측정 실패·0 폭은 1, 극단값은 자른다", () => {
  assert.equal(TL.fitScaleX(100, 10, 0), 1);
  assert.equal(TL.fitScaleX(0, 10, 50), 1);
  assert.equal(TL.fitScaleX(1e9, 10, 1), 50);
  assert.equal(TL.fitScaleX(1e-9, 10, 1000), 0.02);
});

test("회전된 줄 — rotate 가 scaleX 앞에 오고 중심은 글 방향 기준으로 잡힌다", () => {
  const page = { w: 612, h: 792 };
  // rasterize.py 규약: 모서리(x,y) + 글 방향 w + 수직 h. 네 방향의 축정렬 bbox 중심과 같아야 한다.
  const cases = [
    { r: 0, x: 100, y: 200, bbox: [100, 200, 180, 212] },
    { r: 90, x: 212, y: 200, bbox: [200, 200, 212, 280] }, // 아래로 읽음: 수직(아래)=-x
    { r: 180, x: 180, y: 212, bbox: [100, 200, 180, 212] },
    { r: 270, x: 200, y: 280, bbox: [200, 200, 212, 280] }, // 위로 읽음: 수직(아래)=+x
  ];
  for (const c of cases) {
    const l = { x: c.x, y: c.y, w: 80, h: 12, t: "Firm 1", ...(c.r ? { r: c.r } : {}) };
    const [cx, cy] = TL.lineCenter(l);
    near(cx, (c.bbox[0] + c.bbox[2]) / 2, 1e-9);
    near(cy, (c.bbox[1] + c.bbox[3]) / 2, 1e-9);
    const p = TL.placeLine(l, page, measure);
    if (c.r) assert.match(p.transform, new RegExp(`^rotate\\(${c.r}deg\\) scaleX\\(`));
    else assert.match(p.transform, /^scaleX\(/);
  }
});

test("blockAt — 점을 품은 가장 작은 블록, 없으면 undefined", () => {
  const boxes = [
    { id: "b0010", bbox: [50, 50, 550, 700] }, // 그림 전체
    { id: "b0011", bbox: [60, 600, 540, 640] }, // 그 안의 캡션
    { id: "b0012", bbox: [50, 710, 550, 760] },
  ];
  assert.equal(TL.blockAt(100, 620, boxes), "b0011");
  assert.equal(TL.blockAt(100, 300, boxes), "b0010");
  assert.equal(TL.blockAt(100, 705, boxes), undefined);
  assert.equal(TL.blockAt(100, 705, []), undefined);
});

// ── 라이브러리 실물(있으면): 모든 text.json 이 파싱되고, 본문 줄 대부분이 블록에 붙는다 ──
const DOCS = path.join(os.homedir(), "Library/Application Support/Galpi/docs");
test("실물 text.json — 파싱·쪽 안쪽 좌표·블록 매칭률", (t) => {
  if (!fs.existsSync(DOCS)) return t.skip("라이브러리 없음");
  let docs = 0;
  for (const d of fs.readdirSync(DOCS)) {
    const f = path.join(DOCS, d, "document.json");
    if (!fs.existsSync(f)) continue;
    const doc = JSON.parse(fs.readFileSync(f, "utf8"));
    const withText = doc.pages.filter((p) => p.text);
    if (!withText.length) continue;
    docs++;
    let lines = 0;
    let matched = 0;
    for (const p of withText) {
      const pt = TL.parsePageText(JSON.parse(fs.readFileSync(path.join(DOCS, d, p.text), "utf8")));
      assert.ok(pt, `${d} p${p.index} 파싱 실패`);
      near(pt.w, p.width_pt, 0.02);
      near(pt.h, p.height_pt, 0.02);
      const boxes = doc.blocks.filter((b) => b.page === p.index && b.bbox);
      for (const pl of TL.placeLines(pt, measure)) {
        lines++;
        assert.ok(pl.left >= -1 && pl.left <= 101 && pl.top >= -1 && pl.top <= 101, `${d} p${p.index} 쪽 밖 줄: ${pl.t}`);
        if (TL.blockAt(pl.cx, pl.cy, boxes)) matched++;
      }
    }
    t.diagnostic(`${d}: 줄 ${lines} · 블록 매칭 ${((matched / lines) * 100).toFixed(1)}%`);
  }
  if (!docs) t.skip("text.json 있는 문서 없음");
});
