// API 키(REST) 경로의 모델 자동 선택.
//
// 모델 이름을 박아 두면 제공자가 내리는 순간 고장 난다 — 실제로 gemini-2.5-flash-lite 는 새 키(프로젝트)에
// 404 "no longer available to new users" 가 났고, 같은 앱이 옛 키 컴퓨터에서만 돌았다.
// 그래서: 키로 모델 목록을 받는다 → 번역에 맞는 순서(싸고 빠른 최신 모델 먼저)로 후보를 세운다 →
// 번역과 같은 모양의 요청을 실제로 보내 받아 주는 첫 (모델, thinking 값)을 고른다 → 키 지문과 함께 저장.
// 키를 바꾸면 지문이 달라져 다시 고른다. 쓰다가 404/400 이 나면 service 가 잊게 해 다음 호출에서 다시 고른다.
import { createHash } from "node:crypto";
import { getSecret, readSettings, saveSettings, type AIProvider, type RestAutoPick } from "../settings";
import { REST_DEFAULT_MODELS, cmpVersion, versionOf } from "./models";
import { RestBackend, thinkingCandidates } from "./restBackend";
import { AIError, toAIError } from "./types";

const MAX_MODELS = 5; // 실호출로 확인할 후보 수
const TTL_MS = 14 * 24 * 3600_000; // 고른 결과를 다시 확인하는 주기
const FAIL_TTL_MS = 60_000; // 실패를 들고 있는 시간 — 배치마다 목록·확인을 다시 돌리지 않게

const LABEL: Record<AIProvider, string> = { gemini: "Gemini", openai: "OpenAI", anthropic: "Claude" };

// ── 모델 목록 ─────────────────────────────────────────────────────────
// 키는 main 이 secrets 에서 읽는다(렌더러가 들고 있지 않다).
export async function listModels(provider: AIProvider, key: string): Promise<string[]> {
  const fail = (r: Response) => new AIError(r.status === 401 || r.status === 403 ? "auth" : "server", `${LABEL[provider]} 모델 목록 오류 ${r.status}`, r.status);
  if (provider === "gemini") {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${key}`);
    // Gemini 는 잘못된 키에 400 을 준다.
    if (r.status === 400) throw new AIError("auth", "Gemini API 키가 올바르지 않습니다.", 400);
    if (!r.ok) throw fail(r);
    const j = (await r.json()) as any;
    return (j.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m: any) => String(m.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
  }
  if (provider === "openai") {
    const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw fail(r);
    const j = (await r.json()) as any;
    return (j.data ?? [])
      .map((m: any) => m.id as string)
      .filter((id: string) => /^(gpt|o\d|chatgpt)/i.test(id))
      .sort();
  }
  const r = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  if (!r.ok) throw fail(r);
  const j = (await r.json()) as any;
  return (j.data ?? []).map((m: any) => m.id as string).filter(Boolean);
}

// ── 후보 순서 ─────────────────────────────────────────────────────────
// 번역은 짧은 배치를 아주 많이 보낸다 → 각 제공자의 "싸고 빠른" 등급의 최신 버전이 기본이다.
//   Gemini: flash-lite(정식 > 정식 스냅샷 > -latest 별칭 > preview) → 없으면 flash 같은 순서
//   OpenAI: gpt-X-mini 최신 → Claude: haiku 최신
// 이름만으로 고르지 않는다 — 목록에 있어도 새 키에 막힌 모델이 있어 실호출 확인(probe)을 거친다.
const SKIP = /embed|tts|audio|realtime|transcribe|image|imagen|veo|search|moderation|computer|robotics|aqa|dall-e|whisper|-exp|live|native|learnlm|gemma|thinking|deep-research|codex|instruct/i;

export function rankRestModels(provider: AIProvider, ids: string[]): string[] {
  type C = { id: string; rank: number; ver: number[] };
  const out: C[] = [];
  for (const id of new Set(ids)) {
    if (SKIP.test(id)) continue;
    if (provider === "gemini") {
      const m = id.match(/^gemini-(\d+(?:\.\d+)*)-(flash-lite|flash)(.*)$/);
      const alias = id.match(/^gemini-(flash-lite|flash)-latest$/);
      if (m) {
        const tier = m[2] === "flash-lite" ? 0 : 4;
        const tail = m[3];
        const stage = tail === "" ? 0 : /^-\d{3}$/.test(tail) ? 1 : 3; // -001 은 정식 스냅샷, 그 밖(-preview-…)은 미리보기
        out.push({ id, rank: tier + stage, ver: versionOf(m[1]) });
      } else if (alias) {
        out.push({ id, rank: (alias[1] === "flash-lite" ? 0 : 4) + 2, ver: [0] });
      }
    } else if (provider === "openai") {
      const m = id.match(/^gpt-(\d+(?:\.\d+)?)o?-mini$/);
      if (m) out.push({ id, rank: 0, ver: versionOf(m[1]) });
    } else {
      const m = id.match(/^claude-haiku-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/) ?? id.match(/^claude-(\d)(?:-(\d))?-haiku(?:-\d{8})?$/);
      if (m) out.push({ id, rank: 0, ver: [Number(m[1]), Number(m[2] ?? 0)] });
    }
  }
  out.sort((a, b) => a.rank - b.rank || cmpVersion(b.ver, a.ver) || a.id.localeCompare(b.id));
  return out.map((c) => c.id);
}

export function keyTag(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// ── 고르기 ────────────────────────────────────────────────────────────
const inflight = new Map<AIProvider, Promise<RestAutoPick>>();
const failed = new Map<AIProvider, { tag: string; at: number; err: AIError }>();

/** 이 키로 지금 쓸 모델. 저장된 결과가 같은 키·유효 기간이면 그대로, 아니면 목록 → 실호출로 다시 고른다. */
export async function restAutoPick(provider: AIProvider): Promise<RestAutoPick> {
  const key = await getSecret(provider);
  if (!key) throw new AIError("config", `${LABEL[provider]} API 키가 없습니다. 설정 → AI 에서 입력하세요.`);
  const tag = keyTag(key);
  const cached = (await readSettings()).ai?.restAuto?.[provider];
  if (cached?.model && cached.keyTag === tag && Date.now() - cached.at < TTL_MS) return cached;
  const f = failed.get(provider);
  if (f && f.tag === tag && Date.now() - f.at < FAIL_TTL_MS) throw f.err;

  let p = inflight.get(provider);
  if (!p) {
    p = choose(provider, key, tag)
      .catch((err) => {
        const e = toAIError(err);
        failed.set(provider, { tag, at: Date.now(), err: e });
        throw e;
      })
      .finally(() => inflight.delete(provider));
    inflight.set(provider, p);
  }
  return p;
}

async function choose(provider: AIProvider, key: string, tag: string): Promise<RestAutoPick> {
  let ids: string[] = [];
  try {
    ids = await listModels(provider, key);
  } catch (err) {
    const e = toAIError(err);
    if (e.kind === "auth") throw e;
    // 목록만 막힌 경우 — 예전 기본값으로라도 실호출 확인은 해 본다.
  }
  const candidates = rankRestModels(provider, ids).slice(0, MAX_MODELS);
  if (!candidates.length) candidates.push(REST_DEFAULT_MODELS[provider]);

  const be = new RestBackend(provider, "");
  let last: AIError | null = null;
  for (const model of candidates) {
    for (const thinking of thinkingCandidates(provider, model)) {
      const r = await be.probe(model, thinking);
      if (r.ok) {
        const pick: RestAutoPick = { model, thinking, keyTag: tag, at: Date.now() };
        await savePick(provider, pick);
        return pick;
      }
      last = r.error ?? null;
      if (last?.kind === "auth") throw last;
      // 400 = 이 요청 모양(thinking 값)을 거부 → 다음 thinking 값. 그 밖(404·429·5xx·연결)은 다음 모델.
      if (r.status !== 400) break;
    }
  }
  if (last && (last.kind === "rate_limit" || last.kind === "network" || last.kind === "server")) throw last;
  throw new AIError(
    "config",
    `이 API 키로 쓸 수 있는 ${LABEL[provider]} 모델을 찾지 못했습니다${last ? ` (${last.message.slice(0, 120)})` : ""}. 설정 → AI 에서 모델을 직접 고르세요.`,
  );
}

async function savePick(provider: AIProvider, pick: RestAutoPick): Promise<void> {
  const cur = (await readSettings()).ai?.restAuto ?? {};
  await saveSettings({ ai: { restAuto: { ...cur, [provider]: pick } } });
}

/** 고른 모델이 쓰다가 거부됐다(404/400) — 잊고 다음 호출에서 다시 고른다. */
export async function forgetRestAuto(provider: AIProvider): Promise<void> {
  failed.delete(provider);
  const cur = { ...((await readSettings()).ai?.restAuto ?? {}) };
  if (!cur[provider]) return;
  delete cur[provider];
  await saveSettings({ ai: { restAuto: cur } });
}

/** 키를 바꿨다 — 실패 기록만 지운다(저장된 결과는 키 지문이 달라 저절로 무효). */
export function onKeyChanged(provider: AIProvider): void {
  failed.delete(provider);
}
