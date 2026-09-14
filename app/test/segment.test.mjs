// segment.ts 결정적 검증 — 모델 없이 앵커 수학·마스킹 인덱스 매핑을 확인한다.
// 실행: npm test  (node:test 내장, 의존성 0)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SEG = require(path.join(import.meta.dirname, "..", "dist-test", "segment.cjs"));

// ── 라이브러리 실물 블록을 가져온다(없으면 그 테스트만 건너뛴다) ───────────
const DOCS = path.join(os.homedir(), "Library/Application Support/Galpi/docs");
function realBlocks(filter, limit = 40) {
  if (!fs.existsSync(DOCS)) return [];
  const out = [];
  for (const d of fs.readdirSync(DOCS)) {
    const f = path.join(DOCS, d, "document.json");
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const b of j.blocks ?? []) if (filter(b)) out.push({ doc: d, ...b });
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

// 모델 응답을 흉내낸다: 원문을 문장으로 쪼개 en 을 **글자 그대로** 담는다.
// 프롬프트가 요구하는 왕복 제약을 만족하는 이상적 응답이다.
function fakeFullResponse(maskedText, id) {
  const parts = maskedText.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  return { id, seg: parts.map((p, i) => ({ en: [p], ko: `번역${i}` })) };
}
function fakePrefixResponse(maskedText, id, words = 4) {
  const parts = maskedText.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  return { id, seg: parts.map((p, i) => ({ en: [p.split(/\s+/).slice(0, words).join(" ")], ko: `번역${i}` })) };
}

test("마스킹: 이스케이프된 $ 를 수식으로 오인하지 않는다 (파이프라인·RichText 와 동일 패턴)", () => {
  const t = String.raw`firms below \$1 million and high $\ln(\text{BE/ME})$ ratios, where $\ln(\text{BE/ME}) = 0$ holds`;
  const p = SEG.prepare(t);
  assert.equal(p.tokens.length, 2, `수식 2개여야 하는데 ${p.tokens.length}개: ${JSON.stringify(p.tokens)}`);
  assert.equal(p.tokens[0], String.raw`$\ln(\text{BE/ME})$`);
  assert.ok(p.text.includes(String.raw`\$1 million`), "산문이 마스킹되면 안 된다");
});

test("마스킹: 복원이 원문과 글자 단위로 같다", () => {
  const blocks = realBlocks((b) => b.type === "paragraph" && /\$/.test(b.text ?? ""), 60);
  assert.ok(blocks.length > 0, "수식 포함 문단을 못 찾음");
  for (const b of blocks) {
    const p = SEG.prepare(b.text);
    assert.equal(SEG.restore(p, p.text), b.text, `복원 불일치: ${b.doc}/${b.id}`);
  }
});

test("마스킹: 인덱스 매핑이 마스킹 텍스트 전 구간에서 원문과 일치한다", () => {
  const blocks = realBlocks((b) => b.type === "paragraph" && /\$/.test(b.text ?? ""), 30);
  for (const b of blocks) {
    const p = SEG.prepare(b.text);
    // 마스킹 안 된 구간의 문자는 원문 같은 위치의 문자와 같아야 한다
    for (const pc of p.pieces) {
      if (pc.masked) continue;
      for (let k = pc.mStart; k < pc.mEnd; k += 7) {
        const o = SEG.toOriginal(p, k, "start");
        assert.equal(p.original[o], p.text[k], `${b.doc}/${b.id} 인덱스 ${k}`);
      }
    }
  }
});

test("앵커(full): 이상적 응답이면 커버리지 100%, 좌표가 원문 문장과 정확히 일치", () => {
  const blocks = realBlocks((b) => b.type === "paragraph" && (b.text ?? "").length > 300, 40);
  assert.ok(blocks.length >= 10);
  let worst = 1;
  for (const b of blocks) {
    const p = SEG.prepare(b.text);
    const res = SEG.resolve(p, fakeFullResponse(p.text, b.id), b.id, "full");
    worst = Math.min(worst, res.coverage);
    assert.ok(res.spans.every((s) => s.ok), `${b.doc}/${b.id} 앵커 실패 ${res.spans.filter((s) => !s.ok).length}개`);
    // 각 span 이 원문에서 실제 문장 위치를 가리키는가
    for (const s of res.spans) {
      assert.ok(s.start >= 0 && s.end <= b.text.length && s.end > s.start, `${b.id} 잘못된 범위`);
    }
    // span 들이 겹치지 않고 순서대로인가
    for (let i = 1; i < res.spans.length; i++) {
      assert.ok(res.spans[i].start >= res.spans[i - 1].end - 1, `${b.id} span ${i} 가 앞과 겹침`);
    }
  }
  assert.ok(worst > 0.9, `최저 커버리지 ${(worst * 100).toFixed(1)}%`);
});

test("앵커(prefix): 앞 4단어만 받아도 끝 좌표를 다음 앵커로 메워 커버리지가 유지된다", () => {
  const blocks = realBlocks((b) => b.type === "paragraph" && (b.text ?? "").length > 300, 40);
  let worst = 1;
  for (const b of blocks) {
    const p = SEG.prepare(b.text);
    const res = SEG.resolve(p, fakePrefixResponse(p.text, b.id), b.id, "prefix");
    worst = Math.min(worst, res.coverage);
    assert.ok(res.spans.every((s) => s.ok), `${b.doc}/${b.id} prefix 앵커 실패`);
  }
  assert.ok(worst > 0.9, `prefix 최저 커버리지 ${(worst * 100).toFixed(1)}%`);
});

test("앵커: 공백이 어긋난 응답도 \\s+ 로 흡수한다", () => {
  const src = "The first sentence  has   odd spacing. The second\nsentence spans a line break. Third one is plain.";
  const p = SEG.prepare(src, null);
  const raw = {
    id: "b1",
    seg: [
      { en: ["The first sentence has odd spacing."], ko: "가" },
      { en: ["The second sentence spans a line break."], ko: "나" },
      { en: ["Third one is plain."], ko: "다" },
    ],
  };
  const res = SEG.resolve(p, raw, "b1", "full");
  assert.ok(res.spans.every((s) => s.ok), "공백 차이를 못 흡수");
  // 문장 사이 공백은 어느 span 에도 안 들어가므로 100% 는 아니다
  assert.ok(res.coverage > 0.95, `커버리지 ${res.coverage}`);
  assert.equal(src.slice(res.spans[1].start, res.spans[1].end), "The second\nsentence spans a line break.");
});

test("앵커: 모델이 못 찾을 조각을 돌려주면 ok=false 로 표시되고 나머지는 살아남는다", () => {
  const src = "Alpha beta gamma. Delta epsilon zeta. Eta theta iota.";
  const p = SEG.prepare(src, null);
  const res = SEG.resolve(
    p,
    { id: "b1", seg: [{ en: ["Alpha beta gamma."], ko: "가" }, { en: ["존재하지 않는 문장"], ko: "나" }, { en: ["Eta theta iota."], ko: "다" }] },
    "b1",
    "full",
  );
  assert.deepEqual(res.spans.map((s) => s.ok), [true, false, true]);
  assert.ok(res.ko.includes("나"), "앵커 실패해도 번역문은 보존");
});

test("LaTeX 무손실: 센티넬이 하나라도 사라지면 verifyRestore 가 잡는다", () => {
  const t = "Let $x_i$ denote returns and $\\sigma^2$ the variance.";
  const p = SEG.prepare(t);
  assert.equal(p.tokens.length, 2);
  assert.equal(SEG.verifyRestore(p, "수익률 ⟦0⟧ 와 분산 ⟦1⟧").ok, true);
  assert.deepEqual(SEG.verifyRestore(p, "수익률 ⟦0⟧ 만").missing, [1]);
});

test("parseBlocksJson: 코드펜스·머리말을 벗긴다", () => {
  assert.equal(SEG.parseBlocksJson('```json\n[{"id":"a"}]\n```')[0].id, "a");
  assert.equal(SEG.parseBlocksJson('여기 결과입니다:\n[{"id":"b"}]\n감사합니다')[0].id, "b");
  assert.throws(() => SEG.parseBlocksJson("설명만 있고 배열 없음"));
});

test("parseBlocksJson: 잘린 응답에서 온전한 객체만 건져 낸다", () => {
  // 배치가 크면 출력 한도에서 잘려 배열이 안 닫힌다. 통째로 버리면 그 배치 블록이 전부 날아간다.
  const truncated =
    '[{"id":"a","seg":[{"en":["One."],"ko":"하나."}]},' +
    '{"id":"b","seg":[{"en":["Two."],"ko":"둘."}]},' +
    '{"id":"c","seg":[{"en":["Thr';
  const got = SEG.parseBlocksJson(truncated);
  assert.deepEqual(got.map((x) => x.id), ["a", "b"]);
  assert.equal(got[1].seg[0].ko, "둘.");
});

test("parseBlocksJson: 문자열 안 중괄호가 건지기를 망가뜨리지 않는다", () => {
  const t = '[{"id":"a","seg":[{"en":["a } b"],"ko":"괄호 { 안 \\" 따옴표"}]},{"id":"b"';
  assert.deepEqual(SEG.parseBlocksJson(t).map((x) => x.id), ["a"]);
});
