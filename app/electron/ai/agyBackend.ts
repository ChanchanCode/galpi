// agy 백엔드 — AIBackend 를 웜 스페어 풀 위에 얹는다.
// agy 는 system/user 를 나눠 받지 않으므로 한 프롬프트로 합쳐 보낸다.
// 풀은 두 종류다: 번역(galpi, 도구 send_message 뿐) / 채팅(galpi-chat, + view_file · --add-dir 문서 폴더).
import { existsSync } from "node:fs";
import path from "node:path";
import { docsRoot } from "../paths";
import { readSettings } from "../settings";
import { DEFAULT_CHAT_MODEL, type AgyQuotaView } from "./chatTypes";
import { AGENT_NAME, CHAT_AGENT_NAME, DEFAULT_MODEL, activeAccount, ensureAgent, fetchUsage, findAgy, geminiWindows, probeAgy, type QuotaBucket } from "./agy";
import { disposeAllPools, findPool, getPool, type AgyPool, type AgyPoolOptions } from "./agyPool";
import { AIError, type AIBackend, type AIBackendInfo, type AIChunk, type AIMessage, type AIStreamOpts } from "./types";

export type AgyPoolKind = "translate" | "chat";
const TRANSLATE_TURN_TIMEOUT_MS = 180_000;
const CHAT_TURN_TIMEOUT_MS = 300_000;
const QUOTA_TTL_MS = 5 * 60_000;
const MODEL_RE = /^[A-Za-z0-9._-]{1,80}$/;

export function poolOptions(kind: AgyPoolKind, accountHome: string): AgyPoolOptions {
  return kind === "chat"
    ? { agent: CHAT_AGENT_NAME, addDirs: [docsRoot()], accountHome, turnTimeoutMs: CHAT_TURN_TIMEOUT_MS }
    : { agent: AGENT_NAME, accountHome, turnTimeoutMs: TRANSLATE_TURN_TIMEOUT_MS };
}

// 에이전트 파일은 계정 HOME 마다 따로다. 실행당 계정별 1회 대조.
const agentReady = new Set<string>();
async function ensureAgentFor(home: string): Promise<{ ok: boolean; error?: string }> {
  if (agentReady.has(home)) return { ok: true };
  const r = await ensureAgent(home);
  if (r.ok) agentReady.add(home);
  return r;
}

export interface AgyHealth {
  bin: string | null;
  loggedIn: boolean;
  version?: string;
  reason?: string;
  checkedAt: number;
}
// 한도 조회(`/usage`)가 곧 로그인 확인이다 — 무과금이고 대화에도 안 남으므로 하나로 합쳤다.
// 계정마다 다르다 → 어느 HOME 의 판정인지 같이 들고, 현재 계정과 다르면 모르는 것으로 본다.
let health: AgyHealth | null = null;
let healthHome = "";
let healthInflight: Promise<AgyHealth> | null = null;

// ⚠️ **agy 를 부르는 것 자체가 macOS 키체인 프롬프트를 띄운다.**
//    agy 는 거의 매일 갱신되는데, 바이너리가 바뀌면 키체인 ACL 이 무효화되어
//    사용자가 "항상 허용" 을 다시 누를 때까지 **호출마다** 프롬프트가 뜬다(실측: SecurityAgent 기동, 11.5초).
//    그래서 진단 목적의 agy 호출은 **절대 주기적으로 돌리지 않는다.**
//    - 로그인 여부는 "실제 턴이 성공했는가" 로 판단한다(공짜).
//    - `/usage` 조회는 토큰은 안 먹지만 프롬프트는 띄운다 → 사용자가 명시적으로 누를 때만.
export function markLoggedIn(version?: string, home?: string): void {
  const bin = findAgy();
  if (!bin) return;
  health = { bin, loggedIn: true, version: version ?? health?.version, checkedAt: Date.now() };
  if (home) healthHome = home;
}
export function markAuthFailed(reason: string, home?: string): void {
  health = { bin: findAgy(), loggedIn: false, reason, checkedAt: Date.now() };
  if (home) healthHome = home;
}

// force=true 일 때만 실제로 agy 를 부른다. 그 외엔 아는 것만 돌려준다.
export async function agyHealth(force = false): Promise<AgyHealth> {
  const { home } = await activeAccount();
  if (!force && health && (!healthHome || healthHome === home)) return health;
  if (!force) {
    // 한 번도 확인 안 했다 — 바이너리 유무만 파일시스템으로 본다(프롬프트 없음).
    const bin = findAgy();
    return { bin, loggedIn: false, reason: bin ? "아직 확인 전" : "agy 실행 파일을 찾지 못했습니다.", checkedAt: 0 };
  }
  if (healthInflight) return healthInflight;
  healthInflight = (async () => {
    const p = await probeAgy(home);
    health = { bin: p.bin, loggedIn: p.loggedIn, version: p.version, reason: p.reason, checkedAt: Date.now() };
    healthHome = home;
    if (p.loggedIn) quota = { buckets: p.buckets, at: Date.now() };
    else if (p.bin) quota = { buckets: [], at: Date.now(), error: p.reason };
    return health;
  })().finally(() => {
    healthInflight = null;
  });
  return healthInflight;
}

export function invalidateAgyHealth(): void {
  health = null;
  healthHome = "";
}

// ── 한도 ─────────────────────────────────────────────────────────────
let quota: { buckets: QuotaBucket[]; at: number; error?: string } = { buckets: [], at: 0 };

export async function pollQuota(): Promise<typeof quota> {
  await agyHealth(true);
  return quota;
}
export function quotaSnapshot(): typeof quota {
  return quota;
}
// 주기 폴링은 하지 않는다 — 위 주석 참조.
export function stopQuotaPoller(): void {
  /* 폴러 없음 — 호환용 */
}

// 설정 창 한도 바(받아쓰기 agy_usage 이식). 계정별 5분 캐시.
const quotaViews = new Map<string, AgyQuotaView>();
const quotaViewInflight = new Map<string, Promise<AgyQuotaView>>();

export async function quotaView(refresh = false): Promise<AgyQuotaView> {
  const { alias, home } = await activeAccount();
  const cached = quotaViews.get(alias);
  if (!refresh && cached && Date.now() - cached.at < QUOTA_TTL_MS) return cached;
  if (!findAgy()) return { status: "missing", at: Date.now() };
  let p = quotaViewInflight.get(alias);
  if (!p) {
    p = (async (): Promise<AgyQuotaView> => {
      const u = await fetchUsage(home);
      const v: AgyQuotaView = { status: u.status, at: Date.now(), ...(u.status === "ok" ? geminiWindows(u.buckets) : {}) };
      quotaViews.set(alias, v);
      if (u.status === "ok") {
        markLoggedIn(undefined, home);
        quota = { buckets: u.buckets, at: v.at };
      } else if (u.status === "auth") {
        markAuthFailed(u.reason ?? "로그인이 필요합니다.", home);
      }
      return v;
    })()
      .catch((): AgyQuotaView => ({ status: "error", at: Date.now() }))
      .finally(() => quotaViewInflight.delete(alias));
    quotaViewInflight.set(alias, p);
  }
  return p;
}

export function invalidateQuotaView(alias?: string): void {
  if (alias) quotaViews.delete(alias);
  else quotaViews.clear();
}

// ── 풀 ───────────────────────────────────────────────────────────────
export async function poolFor(kind: AgyPoolKind, model: string): Promise<AgyPool> {
  const { home } = await activeAccount();
  return getPool(poolOptions(kind, home), model);
}
export function disposePool(): void {
  disposeAllPools();
}
/** 번역 풀 기준(ai:status 호환). kind="chat" 이면 채팅 풀. */
export async function poolStats(kind: AgyPoolKind = "translate"): Promise<AgyPool["stats"] | null> {
  const { home } = await activeAccount();
  return findPool(poolOptions(kind, home))?.stats ?? null;
}

/** 계정 전환 — 스페어는 옛 HOME 으로 떠 있으니 전부 버리고 판정·한도 스냅숏도 비운다. */
export function onAccountChanged(): void {
  disposeAllPools();
  invalidateAgyHealth();
  quota = { buckets: [], at: 0 };
}

// §2.9 — 진단 목적으로 agy 를 부르지 않는다(호출마다 키체인 프롬프트가 뜬다).
// 그래서 `loggedIn` 은 **실제 턴이 성공해야** 켜지고, 앱을 새로 켠 직후에는 항상 false 다.
// 여기서 loggedIn 을 요구하면 첫 턴이 영원히 안 나가는 교착이 된다:
//   턴을 못 쏨 → markLoggedIn 이 안 불림 → loggedIn 계속 false → 턴을 못 쏨.
// 설정에 성공 이력(ai.agyOk)이 있으면 통과시키고, 진짜 미로그인은 **턴 자체**가 auth 로 알려 준다.
// 단 실제로 확인(checkedAt>0)해서 미로그인이면 막는다 — 그건 추측이 아니라 사실이다.
async function agyUsable(h: AgyHealth): Promise<boolean> {
  if (!h.bin) return false;
  if (h.loggedIn) return true;
  if (h.checkedAt > 0) return false;
  const ai = (await readSettings()).ai;
  // 사용자가 백엔드를 **명시적으로 agy 로 골랐다면** 그게 의도다 — 일단 쏘고 결과로 판정한다.
  // "auto" 는 보수적으로: 성공 이력이 있을 때만. 없으면 resolveBackend 가 REST 로 떨어뜨린다.
  return !!(ai?.agyOk || ai?.backend === "agy");
}

// 요청이 올 것 같을 때 미리 데운다 — 번역: 문서를 열 때, 채팅: 패널을 열 때. 실패해도 조용히.
// **로그인이 확인된(또는 성공 이력이 있는) 뒤에만.** 확인 전에 부르면 프롬프트를 띄우게 된다.
// model 은 "agy:<m>" 이나 맨 모델 id. 채팅 모델이 REST 면 데울 게 없다.
export async function prewarm(kind: AgyPoolKind = "translate", model?: string): Promise<AgyPool["stats"] | null> {
  const s = await readSettings();
  let m = String(model ?? "").trim();
  if (!m) m = kind === "chat" ? (s.ai?.chatModel ?? "").trim() || DEFAULT_CHAT_MODEL : (s.ai?.agyModel ?? "").trim() || DEFAULT_MODEL;
  if (m.startsWith("rest:")) return null;
  if (m.startsWith("agy:")) m = m.slice(4);
  if (!MODEL_RE.test(m)) return null;
  const h = await agyHealth();
  if (!(await agyUsable(h))) return null;
  const { home } = await activeAccount();
  if (!(await ensureAgentFor(home)).ok) return null;
  const pool = getPool(poolOptions(kind, home), m);
  pool.warm();
  return pool.stats;
}

// ── 대화 → 한 프롬프트 ─────────────────────────────────────────────────
// agy 입력은 턴당 문자열 하나다. 이력은 헤더로 평탄화하고 이미지는 **절대경로**로 view_file 을 시킨다
// (상대경로면 모델이 경로를 추측하며 100스텝 넘게 헛돈다 — 실측). add-dir 밖 경로는 어차피 거부되므로 넣지 않는다.
export function flattenMessages(system: string, messages: AIMessage[], allowedRoot: string): string {
  const root = path.resolve(allowedRoot);
  const imageLine = (p: string): string => {
    const abs = path.resolve(p);
    const rel = path.relative(root, abs);
    const inside = path.isAbsolute(p) && !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
    if (!inside || !existsSync(abs)) return "[첨부 이미지 — 열 수 없음]";
    return `[첨부 이미지 — view_file 로 열어 볼 것: ${abs}]`;
  };
  const body = messages
    .map((m) => {
      const lines = m.parts
        .map((part) => (part.type === "text" ? part.text : imageLine(part.path)))
        .filter((t) => t.trim());
      if (!lines.length) return "";
      return `### ${m.role === "user" ? "사용자" : "조수"}\n${lines.join("\n")}`;
    })
    .filter(Boolean)
    .join("\n\n");
  return system.trim() ? `${system}\n\n---\n\n${body}` : body;
}

export interface AgyBackendOpts {
  /** 사용자가 이 모델을 직접 골랐다(route 고정) — 로그인 미확인이어도 일단 쏘고 턴 결과로 판정한다. */
  explicit?: boolean;
  turnTimeoutMs?: number;
}

export class AgyBackend implements AIBackend {
  readonly id = "agy" as const;
  constructor(
    private model: string = DEFAULT_MODEL,
    private bopts: AgyBackendOpts = {},
  ) {}

  async info(): Promise<AIBackendInfo> {
    const h = await agyHealth();
    return {
      id: "agy",
      ready: !!h.bin && h.loggedIn,
      provider: "gemini-agy",
      model: this.model,
      detail: h.bin ? (h.loggedIn ? `agy ${h.version ?? ""} · 로그인됨`.trim() : h.reason) : h.reason,
    };
  }

  async *stream(opts: AIStreamOpts): AsyncGenerator<AIChunk> {
    const h = await agyHealth();
    if (!h.bin) throw new AIError("config", h.reason ?? "agy 를 찾지 못했습니다.");
    if (!this.bopts.explicit && !(await agyUsable(h))) {
      throw new AIError("auth", h.reason ?? "agy 로그인이 필요합니다. 터미널에서 `agy` 를 한 번 실행하세요.");
    }
    const { home } = await activeAccount();
    const ag = await ensureAgentFor(home);
    if (!ag.ok) throw new AIError("config", `galpi 에이전트 파일을 쓰지 못했습니다: ${ag.error}`);

    const model = opts.model || this.model;
    if (!MODEL_RE.test(model)) throw new AIError("config", `agy 모델 이름이 올바르지 않습니다: ${model.slice(0, 40)}`);
    const chat = !!opts.messages?.length;
    const prompt = chat
      ? flattenMessages(opts.system ?? "", opts.messages!, docsRoot())
      : opts.system
        ? `${opts.system}\n\n---\n\n${opts.user}`
        : opts.user;
    const pool = getPool(poolOptions(chat ? "chat" : "translate", home), model);

    // 풀은 델타를 콜백으로 준다 → 제너레이터로 옮기기 위한 작은 큐.
    const queue: string[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    let failed: unknown = null;
    let result: { text: string; usage: any } | null = null;

    void pool
      .runTurn(
        prompt,
        opts.signal,
        (t) => {
          queue.push(t);
          notify?.();
        },
        this.bopts.turnTimeoutMs,
      )
      .then((r) => {
        result = r;
        markLoggedIn(undefined, home);
      })
      .catch((e) => {
        failed = e;
        if (e instanceof AIError && e.kind === "auth") markAuthFailed(e.message, home);
      })
      .finally(() => {
        done = true;
        notify?.();
      });

    for (;;) {
      while (queue.length) yield { text: queue.shift()! };
      if (done) break;
      await new Promise<void>((r) => {
        notify = () => {
          notify = null;
          r();
        };
      });
    }
    if (failed) throw failed;
    if (result) yield { usage: (result as { usage: any }).usage };
  }
}
