// 전역 설정 저장 — 원자적 쓰기 + 부분 병합 + 비밀값 분리 (H1, H2).
//
// H2: 예전에는 렌더러가 보낸 객체로 settings.json 을 통째로 덮어썼다.
//     렌더러는 6개 키만 보내므로 main 이 쓴 pythonPath 가 저장 한 번에 사라졌고,
//     쓰기 도중 크래시하면 파일이 통째로 깨졌다. → tmp+rename + 부분 병합.
// H1: API 키는 settings.json 에 평문으로 있었다. → secrets.json 에 safeStorage 암호화.
import { safeStorage } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { appSupportDir, secretsPath, settingsPath } from "./paths";

export type AIProvider = "gemini" | "openai" | "anthropic";
export const AI_PROVIDERS: AIProvider[] = ["gemini", "openai", "anthropic"];

export interface AISettings {
  provider?: AIProvider;
  models?: Partial<Record<AIProvider, string>>;
  // "auto" = agy 가 살아 있으면 agy, 아니면 BYOK REST (기본).
  backend?: "auto" | "agy" | "rest";
  agyModel?: string;
  // 한 번이라도 agy 턴이 성공했는가 — 진단 호출(=키체인 프롬프트)을 아끼려고 기억해 둔다.
  agyOk?: boolean;
  // agy 계정 별칭 — 그냥 받아쓰기·gemini-acct 와 같은 저장소(~/.claude/.state/gemini-accounts/<alias>). 기본 "main".
  agyAccount?: string;
  // 채팅·요약 기본 모델 id ("agy:<m>" | "rest:<p>:<m>"). 없으면 DEFAULT_CHAT_MODEL.
  chatModel?: string;
  // PDF 추가 시 자동 번역·요약. 없으면 둘 다 켜짐.
  auto?: { translate?: boolean; summary?: boolean };
}
export type Settings = Record<string, unknown> & { ai?: AISettings; pythonPath?: string };

async function readJsonFile(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

// tmp 에 쓰고 rename — rename 은 원자적이라 중간 크래시에도 반쪽 파일이 남지 않는다.
// tmp 이름에 순번을 붙인다 — 같은 파일을 두 곳에서 동시에 쓰면 tmp 가 겹쳐 반쪽 JSON 이 rename 될 수 있다.
let tmpSeq = 0;
export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${(tmpSeq++).toString(36)}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// 쓰기 직렬화 — 동시 저장이 서로를 덮어쓰지 않게 한 줄로 세운다.
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

let settingsCache: Settings | null = null;
let secretsCache: Record<string, string> | null = null;

export async function readSettings(): Promise<Settings> {
  if (settingsCache) return settingsCache;
  settingsCache = ((await readJsonFile(settingsPath())) as Settings | null) ?? {};
  return settingsCache;
}

// 부분 병합 저장. 최상위는 얕은 병합, ai 는 한 단계 더(ai.models·ai.auto 는 그 안에서 또 한 단계) 병합한다.
// patch 에 들어온 ai.keys 는 저장하지 않고 secrets 로 흘려보낸다.
export async function saveSettings(patch: Settings): Promise<Settings> {
  await readSettings();
  const incoming = { ...patch };
  const incomingAI = (incoming.ai ?? undefined) as (AISettings & { keys?: Record<string, string> }) | undefined;
  delete incoming.ai;
  const { keys, ...restAI } = incomingAI ?? {};
  if (keys) for (const [p, v] of Object.entries(keys)) if (typeof v === "string") await setSecret(p, v);

  // **await 가 끝난 뒤에 캐시를 다시 본다.** 앞에서 잡아 둔 cur 로 병합하면 동시에 들어온 다른 저장
  // (채팅 모델·계정·레이아웃이 거의 같은 순간에 저장된다)을 덮어쓴다. 여기서부터 쓰기 예약까지는 동기다.
  const cur = settingsCache ?? {};
  const next: Settings = { ...cur, ...incoming };
  if (incomingAI) {
    const ai: AISettings = { ...(cur.ai ?? {}), ...restAI, models: { ...(cur.ai?.models ?? {}), ...(restAI.models ?? {}) } };
    if (cur.ai?.auto || restAI.auto) ai.auto = { ...(cur.ai?.auto ?? {}), ...(restAI.auto ?? {}) };
    next.ai = ai;
  }
  delete (next as Record<string, unknown>).translation; // 레거시 평문 키 잔재 제거

  settingsCache = next;
  await serialize(() => atomicWriteJson(settingsPath(), next));
  return next;
}

// ── 비밀값(API 키) ────────────────────────────────────────────────────
// 형식: { v:1, enc:true, data:"<base64>" } — safeStorage 로 암호화한 JSON 객체.
//       safeStorage 를 못 쓰는 환경이면 enc:false 로 평문 저장하되 파일 권한을 600 으로.
async function readSecrets(): Promise<Record<string, string>> {
  if (secretsCache) return secretsCache;
  const raw = (await readJsonFile(secretsPath())) as { enc?: boolean; data?: unknown } | null;
  let out: Record<string, string> = {};
  try {
    if (raw?.enc && typeof raw.data === "string" && safeStorage.isEncryptionAvailable()) {
      out = JSON.parse(safeStorage.decryptString(Buffer.from(raw.data, "base64")));
    } else if (raw && !raw.enc && raw.data && typeof raw.data === "object") {
      out = raw.data as Record<string, string>;
    }
  } catch (err) {
    console.warn("[secrets] 복호화 실패 — 키를 다시 입력해야 합니다:", err);
    out = {};
  }
  secretsCache = out;
  return out;
}

async function writeSecrets(s: Record<string, string>): Promise<void> {
  secretsCache = s;
  const available = safeStorage.isEncryptionAvailable();
  const payload = available
    ? { v: 1, enc: true, data: safeStorage.encryptString(JSON.stringify(s)).toString("base64") }
    : { v: 1, enc: false, data: s };
  await serialize(async () => {
    await atomicWriteJson(secretsPath(), payload);
    await fs.chmod(secretsPath(), 0o600).catch(() => {});
  });
}

export async function getSecret(name: string): Promise<string> {
  return ((await readSecrets())[name] ?? "").trim();
}

export async function setSecret(name: string, value: string): Promise<void> {
  const s = { ...(await readSecrets()) };
  const v = (value ?? "").trim();
  if (v) s[name] = v;
  else delete s[name];
  await writeSecrets(s);
}

export async function secretsPresent(): Promise<Record<string, boolean>> {
  const s = await readSecrets();
  const out: Record<string, boolean> = {};
  for (const p of AI_PROVIDERS) out[p] = !!(s[p] ?? "").trim();
  return out;
}

// 최초 1회: settings.json 에 평문으로 있던 키를 secrets.json 으로 옮기고 원본에서 지운다.
export async function migratePlaintextKeys(): Promise<void> {
  const s = await readSettings();
  const legacyKeys = (s.ai as { keys?: Record<string, string> } | undefined)?.keys ?? {};
  const legacyTranslation = (s as { translation?: { apiKey?: string; model?: string } }).translation;
  const found: Record<string, string> = {};
  for (const [p, v] of Object.entries(legacyKeys)) if (typeof v === "string" && v.trim()) found[p] = v.trim();
  if (legacyTranslation?.apiKey?.trim() && !found.gemini) found.gemini = legacyTranslation.apiKey.trim();
  const hadLegacyShape = !!(s.ai as { keys?: unknown } | undefined)?.keys || !!legacyTranslation;
  if (!hadLegacyShape) return;

  if (Object.keys(found).length) {
    await writeSecrets({ ...(await readSecrets()), ...found });
  }
  const ai: AISettings = { ...(s.ai ?? {}) };
  delete (ai as Record<string, unknown>).keys;
  if (!ai.provider && legacyTranslation) ai.provider = "gemini";
  if (legacyTranslation?.model && !ai.models?.gemini) {
    ai.models = { ...(ai.models ?? {}), gemini: legacyTranslation.model };
  }
  const next: Settings = { ...s, ai };
  delete (next as Record<string, unknown>).translation;
  settingsCache = next;
  await serialize(() => atomicWriteJson(settingsPath(), next));
  console.log("[secrets] 평문 API 키를 secrets.json 으로 이전했습니다.");
}

// main 이 소유한 단일 키 갱신(예: pythonPath) — 렌더러 저장과 충돌하지 않게 병합 경로로.
export async function patchSettings(key: string, value: unknown): Promise<void> {
  await saveSettings({ [key]: value } as Settings);
}

export function appDir(): string {
  return appSupportDir();
}
