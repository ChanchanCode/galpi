// 채팅 모델 목록 · 경로(route) 해석.
// id 형식: "agy:<model>" | "rest:<provider>:<model>" (chatTypes.ChatModelInfo).
// agy 모델은 `agy models` (키체인 프롬프트 없음) → 메모리 + <appSupport>/agy-models.json 24시간 캐시.
import fs from "node:fs/promises";
import path from "node:path";
import { appSupportDir } from "../paths";
import { AI_PROVIDERS, atomicWriteJson, readSettings, secretsPresent, type AIProvider, type Settings } from "../settings";
import { DEFAULT_CHAT_MODEL, LEGACY_CHAT_DEFAULT, type ChatModelInfo, type ChatModelList } from "./chatTypes";
import { activeAccount, findAgy, listAgyModels } from "./agy";

// BYOK 최후 폴백 — 자동 선택(restAuto)이 목록·실호출 확인을 못 했을 때만 쓴다.
// 이름을 박아 두면 제공자가 내리는 순간 고장 난다(2.5-flash-lite 는 새 키에 404) → 기본은 자동이다.
export const REST_DEFAULT_MODELS: Record<AIProvider, string> = {
  gemini: "gemini-2.5-flash-lite",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
};
// 예전 기본값이 설정에 박혀 있던 것 — 사용자가 고른 건지 알 수 없어 자동으로 본다.
const LEGACY_REST_DEFAULTS = new Set(["gemini-2.0-flash", "gemini-2.5-flash-lite"]);

// "auto" = 엔진 설정(구독/API 키)을 따라 그때 쓸 수 있는 모델을 고른다(채팅·요약 기본값).
export type ParsedRoute =
  | { kind: "auto" }
  | { kind: "agy"; model: string }
  | { kind: "rest"; provider: AIProvider; model: string };

const AGY_MODEL_RE = /^[A-Za-z0-9._-]{1,80}$/;
// REST 모델 id 는 URL 경로(Gemini)·JSON 값으로 들어간다 — `/`·`?` 는 받지 않는다. OpenAI 미세조정 id 는 `:` 를 쓴다.
const REST_MODEL_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** "agy:<m>" | "rest:<p>:<m>" → 구조. 형식이 틀리면 null. */
export function parseRoute(id: string | null | undefined): ParsedRoute | null {
  const s = String(id ?? "").trim();
  if (s === "auto") return { kind: "auto" };
  if (s.startsWith("agy:")) {
    const model = s.slice(4);
    return AGY_MODEL_RE.test(model) ? { kind: "agy", model } : null;
  }
  if (s.startsWith("rest:")) {
    const rest = s.slice(5);
    const i = rest.indexOf(":");
    if (i <= 0) return null;
    const provider = rest.slice(0, i) as AIProvider;
    const model = rest.slice(i + 1);
    if (!AI_PROVIDERS.includes(provider) || !REST_MODEL_RE.test(model)) return null;
    if (provider === "gemini" && model.includes(":")) return null;
    return { kind: "rest", provider, model };
  }
  return null;
}

// ── 짧은 라벨 ────────────────────────────────────────────────────────
/** "Gemini 3.8 Flash (Medium)" → "Gemini 3.8 Flash Medium", "Claude Sonnet 4.6 (Thinking)" → "Claude Sonnet 4.6" */
export function shortAgyLabel(label: string, id: string): string {
  const s = (label || id)
    .replace(/\s*\(thinking\)\s*/gi, " ")
    .replace(/\s*\(([^)]*)\)\s*/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
  return s || id;
}

const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w);

/** REST 모델 id → 표시명. 모르는 형식은 단어 머리만 대문자로. */
export function restLabel(id: string): string {
  let m = id.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (m) return `Claude ${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  m = id.match(/^claude-(\d)(?:-(\d))?-(opus|sonnet|haiku)(?:-\d{8})?$/);
  if (m) return `Claude ${m[1]}${m[2] ? `.${m[2]}` : ""} ${cap(m[3])}`;
  if (/^gpt-/i.test(id)) return `GPT-${id.slice(4).replace(/-/g, " ")}`;
  if (/^o\d/.test(id)) return id;
  const words = id
    .replace(/-\d{2}-\d{2}$/, "") // preview 날짜 꼬리
    .replace(/-\d{3,}$/, "")
    .split("-")
    .filter(Boolean);
  return words.map((w) => (/^\d/.test(w) ? w : cap(w))).join(" ") || id;
}

// ── agy 모델 캐시 ─────────────────────────────────────────────────────
// 실측 목록(2026-11-22, agy 1.5.13) — `agy models` 가 실패하면 이걸 쓴다.
// agy 는 옛 모델을 예고 없이 내린다(3.7·3.6 은 "not recognized" 로 거부, 실측) → 실제 선택은 늘 목록에서 한다.
const AGY_FALLBACK: { id: string; label: string }[] = [
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"],
  ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
].map(([id, label]) => ({ id, label }));
export const AGY_LAST_RESORT = "gemini-3.8-flash-low";

const TTL_MS = 24 * 3600_000;
const FAIL_RETRY_MS = 10 * 60_000; // 실패하면 폴백을 10분만 들고 다시 시도 — 매 호출 spawn 방지

interface AgyModelsCache {
  ts: number;
  alias: string;
  models: { id: string; label: string }[];
  /** agy 가 실제로 준 목록인가(false = 폴백). 폴백이면 저장된 모델이 목록에 없다고 버리지 않는다. */
  live?: boolean;
}
let mem: AgyModelsCache | null = null;
let fileChecked = false;
let inflight: Promise<AgyModelsCache> | null = null;

function cacheFile(): string {
  return path.join(appSupportDir(), "agy-models.json");
}

/** 계정 전환 시 — 계정마다 쓸 수 있는 모델이 다를 수 있다. */
export function invalidateModelCache(): void {
  mem = null;
  fileChecked = true; // 파일은 alias 로 구분되지만, 전환 직후엔 새로 받아 두는 편이 맞다
}

async function agyModelList(refresh: boolean): Promise<{ id: string; label: string }[]> {
  return (await agyModels(refresh)).models;
}

/** agy 모델 목록 + 실측 여부. */
export async function agyModels(refresh = false): Promise<{ models: { id: string; label: string }[]; live: boolean }> {
  const c = await agyModelCache(refresh);
  return { models: c.models, live: c.live !== false };
}

async function agyModelCache(refresh: boolean): Promise<AgyModelsCache> {
  const { alias, home } = await activeAccount();
  const now = Date.now();
  if (!refresh && mem && mem.alias === alias && now - mem.ts < TTL_MS) return mem;
  if (!refresh && !mem && !fileChecked) {
    fileChecked = true;
    try {
      const j = JSON.parse(await fs.readFile(cacheFile(), "utf8")) as Partial<AgyModelsCache>;
      const models = Array.isArray(j.models) ? j.models.filter((m) => m && AGY_MODEL_RE.test(String(m.id))) : [];
      if (models.length && typeof j.ts === "number" && (j.alias ?? "main") === alias) {
        mem = { ts: j.ts, alias, live: true, models: models.map((m) => ({ id: String(m.id), label: String(m.label ?? m.id) })) };
        if (now - mem.ts < TTL_MS) return mem;
      }
    } catch {
      /* 캐시 없음 */
    }
  }
  if (!inflight) {
    inflight = (async (): Promise<AgyModelsCache> => {
      const list = await listAgyModels(home).catch(() => []);
      if (list.length) {
        const c = { ts: Date.now(), alias, models: list, live: true };
        await atomicWriteJson(cacheFile(), c).catch(() => {});
        return c;
      }
      const prevLive = !!(mem && mem.alias === alias && mem.live !== false);
      const prev = mem && mem.alias === alias ? mem.models : AGY_FALLBACK;
      return { ts: Date.now() - TTL_MS + FAIL_RETRY_MS, alias, models: prev, live: prevLive };
    })().finally(() => {
      inflight = null;
    });
  }
  const c = await inflight;
  // 받는 사이 계정이 바뀌었으면 메모리에 넣지 않는다(다음 호출이 새 계정으로 다시 받는다).
  if ((await activeAccount()).alias === c.alias) mem = c;
  return c;
}

// ── agy 모델 자동 선택 ─────────────────────────────────────────────────
// 번역은 짧은 배치를 많이 돌린다 → 최신 Flash 의 low(thinking 최소). 채팅은 답의 질 → medium.
// 같은 단계가 없으면 가까운 단계, Flash 가 아예 없으면 아무 Gemini, 그것도 없으면 첫 모델.
export type ModelKind = "translate" | "chat";
const AGY_TIERS: Record<ModelKind, string[]> = { translate: ["low", "medium", "high"], chat: ["medium", "low", "high"] };

/** "3.8" → [3, 8]. 버전 비교용. */
export function versionOf(s: string): number[] {
  return s.split(".").map((x) => Number(x) || 0);
}
export function cmpVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function pickAgyModel(ids: string[], kind: ModelKind): string | null {
  const flash = ids
    .map((id) => {
      const m = id.match(/^gemini-(\d+(?:\.\d+)*)-flash-(low|medium|high)$/);
      return m ? { id, ver: versionOf(m[1]), tier: m[2] } : null;
    })
    .filter((x): x is { id: string; ver: number[]; tier: string } => !!x);
  for (const tier of AGY_TIERS[kind]) {
    const c = flash.filter((f) => f.tier === tier).sort((a, b) => cmpVersion(b.ver, a.ver));
    if (c.length) return c[0].id;
  }
  return ids.find((id) => id.startsWith("gemini-")) ?? ids[0] ?? null;
}

/**
 * 실제로 쓸 agy 모델. 저장된 선택(explicit)은 agy 가 지금도 주는 모델일 때만 따른다 —
 * agy 가 내린 모델(예: 3.7-flash-low)을 계속 보내면 모든 요청이 "not recognized" 로 실패한다.
 */
export async function resolveAgyModel(kind: ModelKind, explicit?: string): Promise<{ model: string; auto: boolean }> {
  const want = String(explicit ?? "").trim().replace(/^agy:/, "");
  const { models, live } = await agyModels(false);
  const ids = models.map((m) => m.id);
  if (want && AGY_MODEL_RE.test(want) && (ids.includes(want) || !live)) return { model: want, auto: false };
  return { model: pickAgyModel(ids, kind) ?? AGY_LAST_RESORT, auto: true };
}

/** agy 모델 id → 짧은 표시명(목록에 있으면 그 라벨). */
export async function agyModelLabel(id: string): Promise<string> {
  const m = (await agyModels(false)).models.find((x) => x.id === id);
  return shortAgyLabel(m?.label ?? "", id);
}

// ── REST 모델 ─────────────────────────────────────────────────────────
// 마지막 ai:listModels 성공 결과(메모리). 음성·이미지·임베딩 전용 모델은 채팅에서 뺀다.
const restSeen: Partial<Record<AIProvider, string[]>> = {};
const NON_CHAT = /embed|tts|audio|realtime|transcribe|image|imagen|veo|search|moderation|computer-use|robotics|aqa|dall-e|whisper|babbage|davinci/i;

export function noteRestModels(provider: AIProvider, models: string[]): void {
  restSeen[provider] = models.filter((m) => REST_MODEL_RE.test(m) && !NON_CHAT.test(m));
}

/** 사용자가 직접 고른 REST 모델. 비었거나 예전 기본값이면 "" = 자동(restAuto 가 고른다). */
export function configuredRestModel(s: Settings, p: AIProvider): string {
  const m = (s.ai?.models?.[p] ?? "").trim();
  return !m || m === "auto" || LEGACY_REST_DEFAULTS.has(m) ? "" : m;
}

/** 저장된 채팅 기본값. 비었거나 예전 기본값(agy:gemini-3.8-flash-medium)이면 "auto". */
export function configuredChatModel(s: Settings): string {
  const m = (s.ai?.chatModel ?? "").trim();
  return !m || m === LEGACY_CHAT_DEFAULT || !parseRoute(m) ? DEFAULT_CHAT_MODEL : m;
}

export async function chatModelList(refresh = false): Promise<ChatModelList> {
  const s = await readSettings();
  const keys = await secretsPresent();
  const bin = findAgy();
  const models: ChatModelInfo[] = [];
  if (bin) {
    for (const m of await agyModelList(refresh)) models.push({ id: `agy:${m.id}`, label: shortAgyLabel(m.label, m.id), group: "agy" });
  }
  const rest: ChatModelInfo[] = [];
  for (const p of AI_PROVIDERS) {
    if (!keys[p]) continue;
    const picked = configuredRestModel(s, p) || s.ai?.restAuto?.[p]?.model || "";
    const ids = [...new Set([picked, ...(restSeen[p] ?? [])])].filter((m) => REST_MODEL_RE.test(m));
    for (const id of ids) {
      if (p === "gemini" && id.includes(":")) continue;
      rest.push({ id: `rest:${p}:${id}`, label: restLabel(id), group: p });
    }
  }
  models.push(...rest);
  // "자동" 항목(맨 위)은 service 가 실제로 고른 모델 이름을 붙여 넣는다.
  return { models, default: configuredChatModel(s) };
}
