// paperContext.ts 검증 — App 과 같은 숨김·병합 규칙, 캡, 모드별 문맥. 합성 문서 + 라이브러리 실물.
// 실행: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PC = require(path.join(import.meta.dirname, "..", "dist-test", "paperContext.cjs"));

const B = (id, type, page, extra = {}) => ({ id, type, page, bbox: null, ...extra });

function synthDoc() {
  const blocks = [
    B("b0000", "heading", 1, { level: 1, text: "A Paper" }),
    B("b0001", "paragraph", 1, { text: "a b s t r a c t" }), // 장식 라벨 → 숨김
    B("b0002", "paragraph", 1, { text: "We study the effect of\nthings on" }), // 문장 미완
    B("b0003", "footnote", 1, { text: "<sup>1</sup> A footnote body." }), // 각주 캐리어 → 끝으로
    B("b0004", "paragraph", 1, { text: "0304-405X/© 1997 Elsevier Science S.A. All rights reserved" }), // footer 잡음 → 버림
    B("b0005", "paragraph", 2, { text: "other things across pages." }), // b0002 에 흡수
    B("b0006", "heading", 2, { level: 2, text: "1. Model" }),
    B("b0007", "formula", 2, { latex: "y = \\beta x\n+ \\varepsilon", display: true }),
    B("b0008", "formula", 2, { latex: "a=b" }),
    B("b0009", "table", 3, { html: `<table><tr><td>Col &amp; A</td><td>B</td></tr><tr><td>${"9".repeat(3000)}</td></tr></table>`, image: "assets/t.jpg" }),
    B("b0010", "figure", 3, { image: "assets/fig1.png", text: "Figure 1: Returns" }),
    B("b0011", "figure", 3, { image: "assets/fig2.png" }),
    B("b0012", "heading", 4, { level: 2, text: "References" }),
    ...Array.from({ length: 60 }, (_, i) => B(`b${String(13 + i).padStart(4, "0")}`, "paragraph", 4, { text: `Author ${i}, 1999, Title of a referenced work number ${i}, Journal of Finance ${i}, 1-20.` + "r".repeat(100) })),
    B("b0080", "heading", 5, { level: 2, text: "Appendix" }),
    B("b0081", "paragraph", 5, { text: "Appendix body text." }),
  ];
  return { doc_id: "synth-1234abcd", title: "A Paper", authors: "Kim and Lee", journal: "JF", source_pdf: "", page_count: 5, pages: [], blocks };
}

test("full: 머리글·병합·라벨 숨김·수식 $$·표·그림·각주·참고문헌 배치", () => {
  const doc = synthDoc();
  const { text, chars, blockIds } = PC.buildPaperContext(doc, "full");
  assert.equal(chars, text.length);
  const lines = text.split("\n");
  assert.equal(lines[0], "# A Paper");
  assert.equal(lines[1], "저자: Kim and Lee");
  assert.equal(lines[2], "저널: JF");
  assert.ok(text.includes("## [b0000] A Paper"));
  assert.ok(!text.includes("[b0001]"), "장식 라벨은 숨김");
  assert.ok(text.includes("[b0002] We study the effect of things on other things across pages."), "페이지 넘김 병합 + 한 줄");
  assert.ok(!text.includes("[b0005]"), "흡수된 조각 id 는 없다");
  assert.ok(!text.includes("[b0004]") && !text.includes("Elsevier"), "footer 잡음은 버린다");
  assert.ok(text.includes("[b0007] $$y = \\beta x + \\varepsilon$$"));
  assert.ok(text.includes("[b0008] $$a=b$$"));
  const tableLine = lines.find((l) => l.startsWith("[b0009]"));
  assert.ok(tableLine.startsWith("[b0009] (표) — Col & A | B / 999"), tableLine.slice(0, 60));
  assert.ok(!/[<>]/.test(tableLine), "태그 제거");
  assert.ok(tableLine.length <= "[b0009] (표) — ".length + PC.TABLE_CAP + 1, `표 캡 ${tableLine.length}`);
  assert.ok(text.includes("[b0010] (그림) Figure 1: Returns"));
  assert.ok(lines.includes("[b0011] (그림)"));
  assert.ok(!text.includes("assets/"), "이미지 경로 없음");
  // 각주·참고문헌은 끝에, 본문(부록 포함) 뒤에
  const iApp = text.indexOf("[b0081] Appendix body text.");
  const iFn = text.indexOf("### Footnotes");
  const iRef = text.indexOf("### References");
  assert.ok(iApp > 0 && iFn > iApp && iRef > iFn, `${iApp} ${iFn} ${iRef}`);
  assert.ok(text.includes("[b0003] <sup>1</sup> A footnote body."));
  assert.ok(!text.includes("## [b0012] References"), "참고문헌 제목은 본문에서 뺀다");
  const refPart = text.slice(iRef + "### References".length);
  assert.ok(refPart.length <= PC.REFERENCES_CAP + 2, `참고문헌 캡 ${refPart.length}`);
  assert.ok(refPart.includes("[b0013]") && !refPart.includes("[b0072]"), "앞에서부터 캡");
  // blockIds: 문맥에 실제로 있는 id 만, 각 id 가 본문에 존재
  for (const id of blockIds) assert.ok(text.includes(`[${id}]`), id);
  assert.ok(!blockIds.includes("b0005") && !blockIds.includes("b0001"));
});

test("full: maxChars — 참고문헌 → 각주 → 본문 뒤쪽 순으로 줄인다", () => {
  const doc = synthDoc();
  const all = PC.buildPaperContext(doc, "full");
  const noRefs = PC.buildPaperContext(doc, "full", null, { maxChars: all.chars - 200 });
  assert.ok(noRefs.chars <= all.chars - 200);
  assert.ok(noRefs.text.includes("### Footnotes"), "각주는 아직 남는다");
  assert.ok(!noRefs.text.includes(PC.TRUNC_MARK), "본문은 안 잘린다");
  const bodyOnly = PC.buildPaperContext(doc, "full", null, { maxChars: all.text.indexOf("### Footnotes") + 5 });
  assert.ok(!bodyOnly.text.includes("### References") && !bodyOnly.text.includes("### Footnotes"));
  const cut = PC.buildPaperContext(doc, "full", null, { maxChars: 1000 });
  assert.ok(cut.chars <= 1000, `${cut.chars}`);
  assert.ok(cut.text.endsWith(PC.TRUNC_MARK));
  assert.ok(cut.text.includes("[b0002]") && !cut.text.includes("[b0081]"), "앞부분을 남기고 뒤를 자른다");
});

test("full: 수식 수동 편집(formula_edits)을 반영한다", () => {
  const { text } = PC.buildPaperContext(synthDoc(), "full", null, { formulaEdits: { b0008: "a \\neq b" } });
  assert.ok(text.includes("[b0008] $$a \\neq b$$"));
});

test("none / summary 모드", () => {
  const doc = synthDoc();
  const none = PC.buildPaperContext(doc, "none");
  assert.equal(none.text, "# A Paper");
  assert.deepEqual(none.blockIds, []);
  doc.blocks.splice(1, 0, B("b9000", "heading", 1, { text: "Abstract" }), B("b9001", "paragraph", 1, { text: "We find X. ".repeat(80) }));
  const sum = PC.buildPaperContext(doc, "summary", {
    v: 1, docId: doc.doc_id, model: "m", ts: "", tldr: "TLDR 문장", question: "Q", method: "M", findings: ["F1", "F2"], contributions: [], limitations: ["L"], keywords: ["k1", "k2"], questions: ["?"],
  });
  assert.ok(sum.text.includes("### Abstract\n[b9001] We find X."));
  assert.ok(sum.text.includes("- [b0006] 1. Model"));
  assert.ok(sum.text.includes("TLDR 문장") && sum.text.includes("- F2") && sum.text.includes("k1, k2"));
  assert.ok(!sum.text.includes("[b0081]"), "본문은 없다");
  const noSum = PC.buildPaperContext(doc, "summary", null);
  assert.ok(!noSum.text.includes("TLDR"));
});

test("tableHtmlToText: 행·칸 구분과 엔티티", () => {
  assert.equal(PC.tableHtmlToText("<table><tr><th>a</th><th>b&lt;c</th></tr><tr><td>1</td><td>2<br/>3</td></tr></table>"), "a | b<c / 1 | 2 3");
});

// ── 라이브러리 실물 ──
const DOCS = path.join(os.homedir(), "Library/Application Support/Galpi/docs");
function realDocs() {
  if (!fs.existsSync(DOCS)) return [];
  return fs
    .readdirSync(DOCS)
    .map((d) => path.join(DOCS, d, "document.json"))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
}

test("실물: id 가 문맥에 있고 절마다 읽기 순서, 캡·수식·흡수 규칙을 지킨다", (t) => {
  const docs = realDocs();
  if (!docs.length) return t.skip("라이브러리 없음");
  for (const doc of docs) {
    const { text, chars, blockIds } = PC.buildPaperContext(doc, "full");
    assert.ok(chars <= PC.DEFAULT_MAX_CHARS, `${doc.doc_id} ${chars}`);
    assert.ok(blockIds.length > doc.blocks.length * 0.5, `${doc.doc_id} id ${blockIds.length}/${doc.blocks.length}`);
    const order = new Map(doc.blocks.map((b, i) => [b.id, i]));
    const { merge } = PC.hiddenSets(doc.blocks);
    // 절(본문 / Footnotes / References) 안에서는 문서 순서 그대로
    const sections = text.split(/\n### (?:Footnotes|References)\n/);
    for (const sec of sections) {
      const ids = [...sec.matchAll(/^(?:## |- )?\[(b\d+)\]/gm)].map((m) => m[1]);
      for (let i = 1; i < ids.length; i++) assert.ok(order.get(ids[i]) > order.get(ids[i - 1]), `${doc.doc_id} 순서 ${ids[i - 1]} → ${ids[i]}`);
    }
    for (const id of blockIds) {
      assert.ok(order.has(id), `${doc.doc_id} 없는 id ${id}`);
      assert.ok(!merge.absorbed.has(id), `${doc.doc_id} 흡수된 id ${id}`);
      assert.equal(text.split(`[${id}]`).length - 1, 1, `${doc.doc_id} id 중복/누락 ${id}`);
    }
    for (const b of doc.blocks.filter((x) => x.type === "formula" && x.latex?.trim())) {
      assert.ok(text.includes(`[${b.id}] $$`), `${doc.doc_id} 수식 ${b.id}`);
    }
    for (const line of text.split("\n").filter((l) => /^\[b\d+\] \(표\)/.test(l))) {
      assert.ok(line.length < 40 + 200 + PC.TABLE_CAP, `${doc.doc_id} 표 길이 ${line.length}`);
    }
    const ri = text.indexOf("\n### References\n");
    if (ri >= 0) assert.ok(text.length - ri <= PC.REFERENCES_CAP + 20, `${doc.doc_id} 참고문헌 ${text.length - ri}`);
    // 문맥 캡을 줄여도 규칙 유지
    const small = PC.buildPaperContext(doc, "full", null, { maxChars: 20_000 });
    assert.ok(small.chars <= 20_000 && small.text.endsWith(PC.TRUNC_MARK));
    const sum = PC.buildPaperContext(doc, "summary");
    assert.ok(sum.chars < 12_000 && sum.text.includes("### Sections"), `${doc.doc_id} summary ${sum.chars}`);
  }
});
