// 채팅 모델 목록 · 경로(route) 해석.
// id 형식: "agy:<model>" | "rest:<provider>:<model>" (chatTypes.ChatModelInfo).
// agy 모델은 `agy models` (키체인 프롬프트 없음) → 메모리 + <appSupport>/agy-models.json 24시간 캐시.
import fs from "node:fs/promises";
import path from "node:path";
import { appSupportDir } from "../paths";
import { AI_PROVIDERS, atomicWriteJson, readSettings, secretsPresent, type AIProvider, type Settings } from "../settings";
import { DEFAULT_CHAT_MODEL, type ChatModelInfo, type ChatModelList } from "./chatTypes";
import { activeAccount, findAgy, listAgyModels } from "./agy";

// BYOK 기본 모델 — 설정에 모델이 없을 때(service.resolveBackend 와 같은 값).
export const REST_DEFAULT_MODELS: Record<AIProvider, string> = {
  gemini: "gemini-2.5-flash-lite",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
};

export type ParsedRoute = { kind: "agy"; model: string } | { kind: "rest"; provider: AIProvider; model: string };

const AGY_MODEL_RE = /^[A-Za-z0-9._-]{1,80}$/;
// REST 모델 id 는 URL 경로(Gemini)·JSON 값으로 들어간다 — `/`·`?` 는 받지 않는다. OpenAI 미세조정 id 는 `:` 를 쓴다.
const REST_MODEL_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** "agy:<m>" | "rest:<p>:<m>" → 구조. 형식이 틀리면 null. */
export function parseRoute(id: string | null | undefined): ParsedRoute | null {
  const s = String(id ?? "").trim();
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
// 실측 목록(2026-09-13, agy 1.2.x) — `agy models` 가 실패하면 이걸 쓴다.
const AGY_FALLBACK: { id: string; label: string }[] = [
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["gemini-3.7-flash-high", "Gemini 3.7 Flash (High)"],
  ["gemini-3.7-flash-medium", "Gemini 3.7 Flash (Medium)"],
  ["gemini-3.7-flash-low", "Gemini 3.7 Flash (Low)"],
  ["gemini-3.6-flash-high", "Gemini 3.6 Flash (High)"],
  ["gemini-3.6-flash-medium", "Gemini 3.6 Flash (Medium)"],
  ["gemini-3.6-flash-low", "Gemini 3.6 Flash (Low)"],
  ["gemini-3.1-pro-high", "Gemini 3.1 Pro (High)"],
  ["gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"],
  ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
].map(([id, label]) => ({ id, label }));

const TTL_MS = 24 * 3600_000;
const FAIL_RETRY_MS = 10 * 60_000; // 실패하면 폴백을 10분만 들고 다시 시도 — 매 호출 spawn 방지

interface AgyModelsCache {
  ts: number;
  alias: string;
  models: { id: string; label: string }[];
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
  const { alias, home } = await activeAccount();
  const now = Date.now();
  if (!refresh && mem && mem.alias === alias && now - mem.ts < TTL_MS) return mem.models;
  if (!refresh && !mem && !fileChecked) {
    fileChecked = true;
    try {
      const j = JSON.parse(await fs.readFile(cacheFile(), "utf8")) as Partial<AgyModelsCache>;
      const models = Array.isArray(j.models) ? j.models.filter((m) => m && AGY_MODEL_RE.test(String(m.id))) : [];
      if (models.length && typeof j.ts === "number" && (j.alias ?? "main") === alias) {
        mem = { ts: j.ts, alias, models: models.map((m) => ({ id: String(m.id), label: String(m.label ?? m.id) })) };
        if (now - mem.ts < TTL_MS) return mem.models;
      }
    } catch {
      /* 캐시 없음 */
    }
  }
  if (!inflight) {
    inflight = (async (): Promise<AgyModelsCache> => {
      const list = await listAgyModels(home).catch(() => []);
      if (list.length) {
        const c = { ts: Date.now(), alias, models: list };
        await atomicWriteJson(cacheFile(), c).catch(() => {});
        return c;
      }
      const prev = mem && mem.alias === alias ? mem.models : AGY_FALLBACK;
      return { ts: Date.now() - TTL_MS + FAIL_RETRY_MS, alias, models: prev };
    })().finally(() => {
      inflight = null;
    });
  }
  const c = await inflight;
  // 받는 사이 계정이 바뀌었으면 메모리에 넣지 않는다(다음 호출이 새 계정으로 다시 받는다).
  if ((await activeAccount()).alias === c.alias) mem = c;
  return c.models;
}

// ── REST 모델 ─────────────────────────────────────────────────────────
// 마지막 ai:listModels 성공 결과(메모리). 음성·이미지·임베딩 전용 모델은 채팅에서 뺀다.
const restSeen: Partial<Record<AIProvider, string[]>> = {};
const NON_CHAT = /embed|tts|audio|realtime|transcribe|image|imagen|veo|search|moderation|computer-use|robotics|aqa|dall-e|whisper|babbage|davinci/i;

export function noteRestModels(provider: AIProvider, models: string[]): void {
  restSeen[provider] = models.filter((m) => REST_MODEL_RE.test(m) && !NON_CHAT.test(m));
}

export function configuredRestModel(s: Settings, p: AIProvider): string {
  const m = (s.ai?.models?.[p] ?? "").trim();
  return !m || m === "gemini-2.0-flash" ? REST_DEFAULT_MODELS[p] : m;
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
    const ids = [...new Set([configuredRestModel(s, p), ...(restSeen[p] ?? [])])].filter((m) => REST_MODEL_RE.test(m));
    for (const id of ids) {
      if (p === "gemini" && id.includes(":")) continue;
      rest.push({ id: `rest:${p}:${id}`, label: restLabel(id), group: p });
    }
  }
  models.push(...rest);
  // agy 도 키도 없으면 빈 선택지 대신 실측 목록 — 보내면 원인(설치·키)이 오류로 뜬다.
  if (!models.length) for (const m of AGY_FALLBACK) models.push({ id: `agy:${m.id}`, label: shortAgyLabel(m.label, m.id), group: "agy" });

  let def = (s.ai?.chatModel ?? "").trim();
  if (!parseRoute(def)) def = DEFAULT_CHAT_MODEL;
  if (def.startsWith("agy:") && !bin && rest.length) def = rest[0].id;
  return { models, default: def };
}
