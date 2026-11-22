// 모델 자동 선택 결정적 검증 — 이름을 박아 둔 기본 모델이 제공자에서 사라져도 앱이 스스로 고르는지.
// 실측 배경: agy 1.5.13 은 gemini-3.7-flash-low 를 "not recognized" 로 거부하고, Gemini API 는 새 키에
// gemini-2.5-flash-lite 를 404 로 막았다. Gemini 3.x 는 thinkingBudget 0 을 400 으로 거부했다.
// 실행: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dist = (n) => require(path.join(import.meta.dirname, "..", "dist-test", `${n}.cjs`));
const M = dist("models");
const R = dist("restAuto");
const B = dist("restBackend");

// agy 1.5.13 실측 목록 (2026-11-22)
const AGY_NOW = ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"];

test("agy: 번역은 최신 Flash low, 채팅은 최신 Flash medium", () => {
  assert.equal(M.pickAgyModel(AGY_NOW, "translate"), "gemini-3.8-flash-low");
  assert.equal(M.pickAgyModel(AGY_NOW, "chat"), "gemini-3.8-flash-medium");
});

test("agy: 버전이 섞여 있으면 가장 높은 버전 (3.10 > 3.8)", () => {
  const ids = ["gemini-3.8-flash-low", "gemini-3.10-flash-low", "gemini-3.9-flash-medium"];
  assert.equal(M.pickAgyModel(ids, "translate"), "gemini-3.10-flash-low");
  assert.equal(M.pickAgyModel(ids, "chat"), "gemini-3.9-flash-medium");
});

test("agy: 같은 단계가 없으면 가까운 단계, Flash 가 없으면 아무 Gemini, 그것도 없으면 첫 모델", () => {
  assert.equal(M.pickAgyModel(["gemini-4.0-flash-high", "gemini-4.0-flash-medium"], "translate"), "gemini-4.0-flash-medium");
  assert.equal(M.pickAgyModel(["claude-sonnet-4-6", "gemini-4.0-pro-low"], "translate"), "gemini-4.0-pro-low");
  assert.equal(M.pickAgyModel(["claude-sonnet-4-6"], "chat"), "claude-sonnet-4-6");
  assert.equal(M.pickAgyModel([], "chat"), null);
});

test("route: auto 를 받고, 예전 경로 형식도 그대로", () => {
  assert.deepEqual(M.parseRoute("auto"), { kind: "auto" });
  assert.deepEqual(M.parseRoute("agy:gemini-3.8-flash-medium"), { kind: "agy", model: "gemini-3.8-flash-medium" });
  assert.deepEqual(M.parseRoute("rest:gemini:gemini-3.5-flash-lite"), { kind: "rest", provider: "gemini", model: "gemini-3.5-flash-lite" });
  assert.equal(M.parseRoute("bogus"), null);
});

test("설정: 비었거나 예전 기본값이면 자동", () => {
  const s = (ai) => ({ ai });
  assert.equal(M.configuredRestModel(s({ models: { gemini: "gemini-2.5-flash-lite" } }), "gemini"), "");
  assert.equal(M.configuredRestModel(s({ models: { gemini: "" } }), "gemini"), "");
  assert.equal(M.configuredRestModel(s({ models: { gemini: "gemini-3.5-flash" } }), "gemini"), "gemini-3.5-flash");
  assert.equal(M.configuredChatModel(s({ chatModel: "agy:gemini-3.8-flash-medium" })), "auto");
  assert.equal(M.configuredChatModel(s({})), "auto");
  assert.equal(M.configuredChatModel(s({ chatModel: "rest:openai:gpt-5-mini" })), "rest:openai:gpt-5-mini");
});

test("Gemini 후보: flash-lite 정식 최신 → 스냅샷 → latest 별칭 → preview → flash, 음성·이미지·실험 제외", () => {
  const ids = [
    "gemini-2.5-flash-lite", "gemini-3.5-flash-lite", "gemini-3.5-flash-lite-preview-09-2026", "gemini-3.5-flash",
    "gemini-flash-lite-latest", "gemini-3.0-flash-lite-001", "gemini-3.5-pro", "gemini-3.5-flash-image",
    "gemini-3.5-flash-native-audio", "gemini-2.0-flash-exp", "gemini-3.5-flash-tts", "text-embedding-004", "gemma-3-27b-it",
  ];
  assert.deepEqual(R.rankRestModels("gemini", ids), [
    "gemini-3.5-flash-lite", "gemini-2.5-flash-lite", "gemini-3.0-flash-lite-001", "gemini-flash-lite-latest",
    "gemini-3.5-flash-lite-preview-09-2026", "gemini-3.5-flash",
  ]);
});

test("OpenAI·Claude 후보: 최신 mini · 최신 haiku", () => {
  assert.deepEqual(R.rankRestModels("openai", ["gpt-4o-mini", "gpt-5-mini", "gpt-4.1-mini", "gpt-5", "gpt-4o-mini-tts", "gpt-5-mini-2025-08-07"]),
    ["gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"]);
  assert.deepEqual(R.rankRestModels("anthropic", ["claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022", "claude-sonnet-4-6"]),
    ["claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022"]);
});

test("thinking 후보: 2.5 flash 만 budget 0, 3.x 는 thinkingLevel, 모르면 붙이지 않는다", () => {
  assert.deepEqual(B.thinkingCandidates("gemini", "gemini-2.5-flash-lite"), [{ thinkingBudget: 0 }, null]);
  assert.deepEqual(B.thinkingCandidates("gemini", "gemini-3.5-flash-lite"), [{ thinkingLevel: "minimal" }, { thinkingLevel: "low" }, null]);
  assert.deepEqual(B.thinkingCandidates("gemini", "gemini-2.5-pro"), [null]);
  assert.equal(B.thinkingCandidates("openai", "gpt-4o-mini").length, 1);
  assert.equal(B.thinkingCandidates("openai", "gpt-5-mini").at(-1), null);
  assert.deepEqual(B.thinkingCandidates("anthropic", "claude-haiku-4-5-20251001"), [null]);
});
