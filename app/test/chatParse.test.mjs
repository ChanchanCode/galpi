// chatParse.ts 결정적 검증 — 대화 조립(기록 캡·이미지 창·인용)·요약 JSON 살리기·인용 id·자동 제목·이미지 헤더.
// 실행: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const CP = require(path.join(import.meta.dirname, "..", "dist-test", "chatParse.cjs"));

const abs = (f) => `/abs/doc/${f}`;
const u = (text, extra = {}) => ({ id: `m${Math.random()}`, role: "user", text, ts: "", ...extra });
const a = (text, extra = {}) => ({ id: `m${Math.random()}`, role: "assistant", text, ts: "", status: "done", ...extra });
const img = (n) => ({ id: `a${n}`, kind: "image", file: `ai/chats/att/${n}.png`, mime: "image/png" });
const texts = (m) => m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
const images = (m) => m.parts.filter((p) => p.type === "image").map((p) => p.path);

test("조립: 마지막 원소가 이번 질문, 역할 교대 유지", () => {
  const s = { messages: [u("q1"), a("a1"), u("q2"), a("a2")] };
  const out = CP.buildChatMessages(s, { text: "q3" }, abs);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.equal(texts(out.at(-1)), "q3");
});

test("조립: 오류·중단인 빈 assistant 는 빠지고, 이어진 user 는 한 메시지로 합쳐진다", () => {
  const s = {
    messages: [u("q1"), a("", { status: "error", error: { kind: "network", message: "x" } }), u("q2"), a("", { status: "canceled" }), u("q3"), a("부분 답", { status: "canceled" })],
  };
  const out = CP.buildChatMessages(s, { text: "q4" }, abs);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(texts(out[0]), "q1\nq2\nq3");
  assert.equal(texts(out[1]), "부분 답", "부분 텍스트가 있는 중단 답은 남는다");
});

test("조립: 인용은 > 블록인용 + 출처 id, 질문 앞에 온다", () => {
  const out = CP.buildChatMessages(
    { messages: [] },
    { text: "무슨 뜻?", quotes: [{ text: "line one\nline two", origin: "source", blockId: "b0042" }, { text: "번역 구절", origin: "translation", blockId: "b0007" }] },
    abs,
  );
  const t = texts(out[0]);
  assert.equal(t, "> line one\n> line two\n> — [b0042]\n\n> 번역 구절\n> — [b0007] 번역문\n\n무슨 뜻?");
});

test("조립: 과거 텍스트 40,000자 캡 — 오래된 것부터 버리고 user 로 시작한다", () => {
  const big = "x".repeat(15_000);
  const s = { messages: [u("old-" + big), a("ans-" + big), u("mid-" + big), a("last-" + "y".repeat(100))] };
  const out = CP.buildChatMessages(s, { text: "now" }, abs);
  const all = out.map(texts).join("|");
  assert.ok(!all.includes("old-"), "가장 오래된 user 는 버려진다");
  assert.ok(!all.includes("ans-"), "user 없이 남은 선두 assistant 도 버려진다");
  assert.equal(out[0].role, "user");
  assert.ok(texts(out[0]).startsWith("mid-"));
  const pastChars = out.slice(0, -1).reduce((n, m) => n + texts(m).length, 0);
  assert.ok(pastChars <= 40_000, `과거 합계 ${pastChars}`);
  assert.equal(texts(out.at(-1)), "now", "이번 질문은 캡과 무관");
  // 이번 질문이 캡보다 커도 버리지 않는다
  const out2 = CP.buildChatMessages({ messages: [] }, { text: "z".repeat(50_000) }, abs);
  assert.equal(texts(out2[0]).length, 50_000);
});

test("조립: 이미지는 첨부가 있는 마지막 두 user 메시지만 실제 part, 그 전은 자리표시", () => {
  const s = { messages: [u("p1", { attachments: [img(1)] }), a("r1"), u("p2", { attachments: [img(2), img(3)] }), a("r2"), u("p3"), a("r3")] };
  const out = CP.buildChatMessages(s, { text: "p4", attachments: [img(4)] }, abs);
  assert.deepEqual(images(out[0]), []);
  assert.ok(texts(out[0]).startsWith(CP.OMITTED_IMAGE));
  assert.deepEqual(images(out[2]), [abs("ai/chats/att/2.png"), abs("ai/chats/att/3.png")]);
  assert.deepEqual(images(out.at(-1)), [abs("ai/chats/att/4.png")]);
  // 이번 질문에 첨부가 없으면 과거 두 개가 창이다
  const out2 = CP.buildChatMessages(s, { text: "p4" }, abs);
  assert.deepEqual(images(out2[0]), [abs("ai/chats/att/1.png")]);
  assert.equal(images(out2[2]).length, 2);
  // resolveAbs 가 거부한 첨부는 빠진다
  const out3 = CP.buildChatMessages({ messages: [] }, { text: "q", attachments: [img(9), { ...img(8), file: "../../etc/passwd" }] }, (f) => (f.includes("..") ? null : abs(f)));
  assert.deepEqual(images(out3[0]), [abs("ai/chats/att/9.png")]);
});

test("autoTitle: 첫 줄 40자, 머리 기호 제거, 빈 입력", () => {
  assert.equal(CP.autoTitle("\n  ## 이 논문의   식별 전략은?\n둘째 줄"), "이 논문의 식별 전략은?");
  const long = "가".repeat(45);
  assert.equal(CP.autoTitle(long), "가".repeat(40) + "…");
  assert.equal(CP.autoTitle("😀".repeat(41)), "😀".repeat(40) + "…", "코드포인트 기준");
  assert.equal(CP.autoTitle("   \n "), "새 대화");
});

test("extractCites: 단일·복수·중복·잡음", () => {
  assert.deepEqual(CP.extractCites("결과는 [b0042] 와 [b0042, b0051] 및 [b0100;b0101]. [x0001] [b12] $[b]$"), ["b0042", "b0051", "b0100", "b0101"]);
  assert.deepEqual(CP.extractCites(""), []);
});

const FULL = {
  tldr: "요약 $\\beta$",
  question: "질문",
  method: "방법",
  data: "CRSP",
  findings: ["f1 [b0042]", "f2"],
  contributions: ["c1"],
  limitations: ["l1"],
  keywords: ["k1", "k2"],
  questions: ["q1?", "q2?", "q3?", "q4?"],
};

test("parseSummaryJson: 그대로·코드펜스·앞뒤 잡음", () => {
  const j = JSON.stringify(FULL);
  assert.deepEqual(CP.parseSummaryJson(j), FULL);
  assert.deepEqual(CP.parseSummaryJson("```json\n" + j + "\n```"), FULL);
  assert.deepEqual(CP.parseSummaryJson("Here is the summary:\n```\n" + j + "\n```\nHope this helps {}"), FULL);
  assert.deepEqual(CP.parseSummaryJson("요약입니다 " + j + " 끝 {잡음}"), FULL);
  assert.equal(CP.parseSummaryJson("JSON 이 아닙니다"), null);
  assert.equal(CP.parseSummaryJson('{"foo": 1}'), null, "알려진 필드가 없으면 null");
});

test("parseSummaryJson: 잘린 JSON — 열린 문자열·배열·키를 닫아 살린다", () => {
  const j = JSON.stringify(FULL, null, 2);
  const cutInList = j.slice(0, j.indexOf('"f2"') + 3); // "f2 까지
  const r1 = CP.parseSummaryJson(cutInList);
  assert.equal(r1.tldr, FULL.tldr);
  assert.deepEqual(r1.findings, ["f1 [b0042]", "f2"]);
  const cutInKey = j.slice(0, j.indexOf('"contributions"') + 6); // "contr
  const r2 = CP.parseSummaryJson("```json\n" + cutInKey);
  assert.deepEqual(r2.findings, FULL.findings);
  assert.equal(r2.contributions, undefined);
  const cutAfterColon = j.slice(0, j.indexOf('"method"') + '"method":'.length);
  const r3 = CP.parseSummaryJson(cutAfterColon);
  assert.equal(r3.question, "질문");
  assert.equal(r3.method, undefined);
});

test("parseSummaryJson: 문자열 안 LaTeX 역슬래시 한 번·날 줄바꿈도 살린다", () => {
  const raw = '{"tldr": "베타 $\\beta$ 와 $\\alpha_i$, 분수 $\\frac{1}{2}$\n둘째 줄", "method": "줄\\n바꿈 $\\theta$ 와 $\\sigma$", "keywords": ["\\text{BE/ME}"]}';
  const r = CP.parseSummaryJson(raw);
  assert.ok(r, "파싱 실패");
  assert.equal(r.tldr, "베타 $\\beta$ 와 $\\alpha_i$, 분수 $\\frac{1}{2}$\n둘째 줄");
  assert.equal(r.method, "줄\n바꿈 $\\theta$ 와 $\\sigma$");
  assert.deepEqual(r.keywords, ["\\text{BE/ME}"]);
  // 제대로 두 번 쓴 것은 건드리지 않는다
  assert.equal(CP.parseSummaryJson(JSON.stringify({ tldr: "$\\beta$ \\n" })).tldr, "$\\beta$ \\n");
});

test("parseSummaryJson: 필드 형 보정(문자열 목록·배열 문자열)", () => {
  const r = CP.parseSummaryJson('{"tldr": ["a", "b"], "findings": "하나", "keywords": [1, {"k": "v"}, ""]}');
  assert.equal(r.tldr, "- a\n- b");
  assert.deepEqual(r.findings, ["하나"]);
  assert.deepEqual(r.keywords, ["1", "v"]);
});

// ── 이미지 헤더 ──
test("sniffImage: PNG·GIF·WEBP·JPEG 매직과 크기, 그 외 null", () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(1234, 16);
  png.writeUInt32BE(567, 20);
  assert.deepEqual(CP.sniffImage(png), { mime: "image/png", w: 1234, h: 567 });
  const gif = Buffer.from("GIF89a\x10\x00\x20\x00", "latin1");
  assert.deepEqual(CP.sniffImage(gif), { mime: "image/gif", w: 16, h: 32 });
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "latin1");
  webp.write("WEBPVP8X", 8, "latin1");
  webp.writeUIntLE(799, 24, 3);
  webp.writeUIntLE(599, 27, 3);
  assert.deepEqual(CP.sniffImage(webp), { mime: "image/webp", w: 800, h: 600 });
  assert.equal(CP.sniffImage(Buffer.from("<svg></svg>")), null);
  assert.equal(CP.sniffImage(Buffer.from("%PDF-1.7 hello")), null);
});

test("sniffImage: 라이브러리 실물 JPEG/PNG 크기가 헤더와 맞다", (t) => {
  const DOCS = path.join(os.homedir(), "Library/Application Support/Galpi/docs");
  if (!fs.existsSync(DOCS)) return t.skip("라이브러리 없음");
  let checked = 0;
  for (const d of fs.readdirSync(DOCS)) {
    for (const sub of ["assets", "pages"]) {
      const dir = path.join(DOCS, d, sub);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => /\.(png|jpe?g)$/i.test(x)).slice(0, 3)) {
        const buf = fs.readFileSync(path.join(dir, f));
        const r = CP.sniffImage(buf);
        assert.ok(r, `${d}/${sub}/${f} 인식 실패`);
        assert.equal(r.mime, /\.png$/i.test(f) ? "image/png" : "image/jpeg");
        assert.ok(r.w > 0 && r.h > 0, `${f} 크기 ${r.w}x${r.h}`);
        checked++;
      }
    }
  }
  if (!checked) t.skip("이미지 없음");
});
