// AI 서비스 — 렌더러가 쓰는 유일한 입구. IPC: ai:stream / ai:cancel / ai:estimate / ai:status.
//
// 한 호출이 지나는 길:
//   차단기 게이트 → 큐(동시 2) → 백엔드 스트림 → 델타 push → 원장 기록 → 차단기 갱신
// 재시도는 5xx/네트워크만, 이미 흘린 텍스트가 없을 때만. 429 는 재시도하지 않는다(H3).
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { existsSync } from "node:fs";
import { getSecret, readSettings, saveSettings, secretsPresent, setSecret, type AIProvider } from "../settings";
import { MAIN_ALIAS, acctHome, listAccounts, normalizeAlias, openLogin, validAlias } from "./accounts";
import { agyCwd, findAgy, gcConversations } from "./agy";
import {
  AgyBackend,
  agyHealth,
  invalidateAgyHealth,
  invalidateQuotaView,
  markAuthFailed,
  markLoggedIn,
  onAccountChanged,
  poolStats,
  pollQuota,
  prewarm,
  quotaSnapshot,
  quotaView,
} from "./agyBackend";
import { liveConversationIds } from "./agyPool";
import type { AgyAccount } from "./chatTypes";
import { REST_DEFAULT_MODELS, chatModelList, configuredRestModel, invalidateModelCache, noteRestModels, parseRoute } from "./models";
import * as breaker from "./breaker";
import { allBias, estimate, EST_RULES_VERSION, observe, observeOut, type BlockKind } from "./estimate";
import { costOf } from "./pricing";
import { promptFor } from "./prompts";
import { JobQueue, PRIORITY_INTERACTIVE } from "./queue";
import { RestBackend } from "./restBackend";
import { AIError, ZERO_USAGE, toAIError, type AIBackend, type AIMessage, type TokenUsage } from "./types";
import {
  cachedTranslations,
  cancelDocTranslation,
  isTranslating,
  planTranslation,
  translateDocument,
  type TranslateDocOpts,
  type TrBlock,
} from "./translateDoc";
import * as usage from "../usage";
import type { UsageScope } from "../usage";

export { parseRoute, type ParsedRoute } from "./models";

const AGY_DEFAULT_MODEL = "gemini-3.7-flash-low";
const MAX_RETRIES = 2;
const BACKOFF_MS = [600, 1800];
const CHAT_MAX_TOKENS = 8192;

export interface AIJobInput {
  jobId: string;
  feature: string;
  /** 원장 in_chars·견적용 본문. messages 가 있으면 비어도 된다(이번 질문 텍스트를 넣으면 된다). */
  text: string;
  docId?: string;
  docTitle?: string;
  scope?: UsageScope;
  model?: string;
  kind?: BlockKind;
  /** 멀티턴·멀티모달 대화(채팅·요약). 마지막 원소가 이번 질문. */
  messages?: AIMessage[];
  /** 있으면 promptFor(feature) 대신 이 시스템 프롬프트. */
  system?: string;
  /** "agy:<model>" | "rest:<provider>:<model>" — 있으면 그 백엔드로 **고정**(폴백 없음). */
  route?: string;
  /** agy 턴 한도(ms). 채팅 기본 300초. */
  turnTimeoutMs?: number;
}

const queue = new JobQueue(2);
const running = new Map<string, AbortController>();
let callSeq = 0;

// 백엔드 선택. "auto" 는 agy 가 살아 있으면 agy, 아니면 BYOK REST 로 떨어진다(D1+D2).
// **여기가 백엔드 교체 지점이다.** 다른 파일은 AIBackend 만 본다.
async function resolveBackend(): Promise<{ backend: AIBackend; provider: string; model: string }> {
  const s = await readSettings();
  const want = s.ai?.backend ?? "auto";
  if (want !== "rest") {
    const h = await agyHealth();
    // 로그인 미확인이라도 설정에 성공 이력이 있으면 agy 로 간다 — 진단 호출을 아끼기 위해서다.
    const verifiedBefore = !!s.ai?.agyOk;
    if (h.bin && (h.loggedIn || verifiedBefore)) {
      const model = (s.ai?.agyModel ?? "").trim() || AGY_DEFAULT_MODEL;
      return { backend: new AgyBackend(model), provider: "gemini-agy", model };
    }
    if (want === "agy") {
      // 명시적으로 agy 를 골랐는데 못 쓰면 조용히 REST 로 갈아타지 않는다 —
      // 사용자가 "구독으로 돌고 있다"고 믿는 채로 유료 키가 태워지면 안 된다.
      return { backend: new AgyBackend(AGY_DEFAULT_MODEL), provider: "gemini-agy", model: AGY_DEFAULT_MODEL };
    }
  }
  const provider = (s.ai?.provider ?? "gemini") as AIProvider;
  const model = configuredRestModel(s, provider) || REST_DEFAULT_MODELS[provider];
  return { backend: new RestBackend(provider, model), provider, model };
}

// 잡 단위 선택 — route 가 있으면 그 백엔드로 못 박는다. 채팅에서 고른 모델이 agy 인데 못 쓰면
// REST 로 조용히 갈아타지 않고 그 백엔드의 auth/config 오류를 그대로 돌려준다(유료 키가 몰래 타면 안 된다).
async function resolveBackendFor(job: AIJobInput): Promise<{ backend: AIBackend; provider: string; model: string }> {
  if (job.route === undefined || job.route === "") {
    const r = await resolveBackend();
    // 경로 없이 들어온 대화 잡도 agy 면 턴 한도를 받아야 한다.
    if (r.backend.id === "agy" && job.turnTimeoutMs) {
      return { ...r, backend: new AgyBackend(r.model, { turnTimeoutMs: job.turnTimeoutMs }) };
    }
    return r;
  }
  const route = parseRoute(job.route);
  if (!route) throw new AIError("config", `모델 경로가 올바르지 않습니다: ${String(job.route).slice(0, 60)}`);
  if (route.kind === "agy") {
    return {
      backend: new AgyBackend(route.model, { explicit: true, turnTimeoutMs: job.turnTimeoutMs }),
      provider: "gemini-agy",
      model: route.model,
    };
  }
  return { backend: new RestBackend(route.provider, route.model), provider: route.provider, model: route.model };
}

/** 견적용 텍스트 조각 — 대화면 텍스트 part 전부(이미지는 세지 않는다), 아니면 text. */
function estimateParts(job: AIJobInput): { text: string; kind: BlockKind }[] {
  if (!job.messages?.length) return [{ text: job.text, kind: job.kind ?? "para" }];
  const parts: { text: string; kind: BlockKind }[] = [];
  for (const m of job.messages) for (const p of m.parts ?? []) if (p.type === "text" && p.text) parts.push({ text: p.text, kind: "para" });
  return parts;
}

// 견적 쪽에서 "지금 실제로 어느 백엔드로 나갈지"를 알아야 한다 —
// agy 는 턴마다 시스템 프롬프트 3,900 토큰이 다시 들어가서 REST 와 견적이 완전히 다르다.
export async function resolvedBackendId(): Promise<string> {
  return (await resolveBackend()).backend.id;
}

// ai:stream 은 렌더러가 직접 부를 수 있다 — 모양이 틀린 대화가 백엔드 안에서 TypeError 로 터지지 않게 여기서 거른다.
// (이미지 경로 경계는 백엔드가 본다: agy 는 --add-dir, REST 는 문서 폴더 prefix.)
function sanitizeMessages(raw: unknown): AIMessage[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AIMessage[] = [];
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || !Array.isArray(m.parts)) continue;
    const parts: AIMessage["parts"] = [];
    for (const p of m.parts) {
      if (p?.type === "text" && typeof p.text === "string") parts.push({ type: "text", text: p.text });
      else if (p?.type === "image" && typeof p.path === "string" && typeof p.mime === "string") parts.push({ type: "image", path: p.path, mime: p.mime });
    }
    if (parts.length) out.push({ role: m.role, parts });
  }
  return out.length ? out : undefined;
}

function normalizeJob(input: AIJobInput): Required<Pick<AIJobInput, "jobId" | "feature" | "text">> & AIJobInput {
  const jobId = String(input?.jobId ?? "").slice(0, 64) || `j_${Date.now().toString(36)}`;
  const feature = String(input?.feature ?? "translate.selection").slice(0, 64);
  const text = String(input?.text ?? "");
  const messages = sanitizeMessages(input?.messages);
  const system = typeof input?.system === "string" ? input.system : undefined;
  const route = typeof input?.route === "string" ? input.route.trim() : undefined;
  const t = Number(input?.turnTimeoutMs);
  const turnTimeoutMs = Number.isFinite(t) && t > 0 ? t : undefined;
  return { ...input, jobId, feature, text, messages, system, route, turnTimeoutMs };
}

interface Attempt {
  text: string;
  usage: TokenUsage;
  ms: number;
}

async function runOnce(
  backend: AIBackend,
  system: string,
  job: AIJobInput,
  model: string,
  signal: AbortSignal,
  onDelta: (t: string) => void,
): Promise<Attempt> {
  const t0 = Date.now();
  let text = "";
  const u: TokenUsage = { ...ZERO_USAGE };
  let streamed = false;
  try {
    const chat = !!job.messages?.length;
    for await (const chunk of backend.stream({
      system,
      user: job.text,
      model,
      signal,
      messages: job.messages,
      maxTokens: chat ? CHAT_MAX_TOKENS : undefined,
    })) {
      if (chunk.text) {
        text += chunk.text;
        streamed = true;
        onDelta(chunk.text);
      }
      if (chunk.usage) Object.assign(u, chunk.usage);
    }
  } catch (err) {
    const e = toAIError(err);
    // 이미 흘려보낸 텍스트가 있으면 재시도해선 안 된다(중복 출력).
    // 취소여도 그때까지 쓴 토큰은 실제로 소모됐다 — 부분 결과를 원장에 남긴다.
    throw Object.assign(e, { streamed, partial: text, partialUsage: u, ms: Date.now() - t0 });
  }
  return { text, usage: u, ms: Date.now() - t0 };
}

// **AI 호출의 단일 통로.** IPC 핸들러와 배치 스케줄러가 둘 다 이걸 부른다.
//   차단기 게이트 → 큐 → 백엔드 스트림 → 델타 → 원장 → 차단기 갱신
export interface AIJobResult {
  jobId?: string;
  text?: string;
  usage?: TokenUsage;
  estimated?: { in: number; out: number };
  error?: ReturnType<AIError["toWire"]>;
  /** 오류·중단 시 그때까지 흘러나온 텍스트(마지막 시도). 채팅이 중단된 답을 보존하는 데 쓴다. */
  partial?: string;
}

export async function runAIJob(
  raw: AIJobInput,
  onDelta: (t: string) => void = () => {},
  priority = PRIORITY_INTERACTIVE,
): Promise<AIJobResult> {
    const job = normalizeJob(raw);
    if (!job.text.trim() && !job.messages) return { error: new AIError("config", "번역할 텍스트가 없습니다.").toWire() };

    // 취소 핸들은 백엔드 결정(await)보다 먼저 건다 — 그 사이에 온 취소가 사라지지 않게.
    const ctrl = new AbortController();
    running.set(job.jobId, ctrl);
    let resolved: Awaited<ReturnType<typeof resolveBackendFor>>;
    try {
      resolved = await resolveBackendFor(job);
      if (ctrl.signal.aborted) throw new AIError("canceled", "중단됨");
    } catch (err) {
      running.delete(job.jobId);
      return { jobId: job.jobId, error: toAIError(err).toWire() };
    }
    const { backend, provider, model } = resolved;
    const systemText = job.system ?? promptFor(job.feature).system;
    // route 가 모델까지 정한다 — job.model 은 route 없는 옛 호출(선택 번역 등)만 쓴다.
    const chosenModel = job.route ? model : (job.model ?? "").trim() || model;
    const providerKey = `${backend.id}:${provider}`;
    const parts = estimateParts(job);
    const inChars = parts.reduce((n, p) => n + p.text.length, 0);
    const est = estimate(parts, { backend: backend.id, systemText, feature: job.feature });
    const scope: UsageScope = job.scope ?? { kind: "selection" };

    const send = onDelta;

    try {
      return await queue.run(job.jobId, async () => {
        let lastErr: AIError | null = null;
        let lastPartial = "";
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            breaker.gate(providerKey, job.feature);
          } catch (err) {
            const be = toAIError(err);
            await write(be, attempt, 0, { ...ZERO_USAGE }, 0);
            return { error: be.toWire() };
          }
          try {
            const r = await runOnce(backend, systemText, job, chosenModel, ctrl.signal, send);
            if (backend.id === "agy") void noteAgyOk();
            breaker.onSuccess(providerKey, job.feature);
            observe(backend.id, est.in, r.usage.in);
            // thinking 은 한도상 출력으로 계산된다(§2.2) → 출력 보정도 함께 본다.
            observeOut(job.feature, est.out, r.usage.out + r.usage.think);
            await write(null, attempt, r.text.length, r.usage, r.ms);
            return { jobId: job.jobId, text: r.text.trim(), usage: r.usage, estimated: est };
          } catch (err) {
            const ae = toAIError(err);
            const streamed = (err as { streamed?: boolean }).streamed === true;
            lastErr = ae;
            if (backend.id === "agy" && ae.kind === "auth") markAuthFailed(ae.message);
            breaker.onFailure(providerKey, job.feature, ae);
            const partial = err as { partial?: string; partialUsage?: TokenUsage; ms?: number };
            lastPartial = partial.partial ?? "";
            await write(ae, attempt, partial.partial?.length ?? 0, partial.partialUsage ?? { ...ZERO_USAGE }, partial.ms ?? 0);
            // 대화 잡의 턴 시간 초과는 다시 돌리지 않는다 — 5분 기다린 뒤 조용히 5분씩 두 번 더 기다리게 된다.
            const timedOut = (err as { timeout?: boolean }).timeout === true && !!job.messages;
            const retryable = (ae.kind === "server" || ae.kind === "network") && !streamed && !timedOut;
            if (!retryable || attempt === MAX_RETRIES || ctrl.signal.aborted) break;
            await sleep(BACKOFF_MS[attempt] ?? 1800, ctrl.signal);
          }
        }
        return {
          jobId: job.jobId,
          error: (lastErr ?? new AIError("network", "알 수 없는 오류")).toWire(),
          ...(lastPartial ? { partial: lastPartial } : {}),
        };
      }, priority);
    } catch (err) {
      // 큐에서 대기하다 취소된 경우 등 — 여기도 원장에 남겨야 잡 단위 회계가 맞는다.
      const ae = toAIError(err);
      await write(ae, 0, 0, { ...ZERO_USAGE }, 0);
      return { error: ae.toWire() };
    } finally {
      running.delete(job.jobId);
    }

    async function write(err: AIError | null, tryNo: number, outChars: number, u: TokenUsage, ms: number) {
      await usage.record({
        v: 1,
        id: `c_${Date.now().toString(36)}_${(callSeq++).toString(36)}`,
        ts: usage.localIso(),
        job_id: job.jobId,
        doc_id: job.docId ?? "",
        doc_title: job.docTitle ?? "",
        feature: job.feature,
        scope,
        backend: backend.id,
        provider,
        model: chosenModel,
        usage: u,
        in_chars: inChars,
        out_chars: outChars,
        est_in: est.in,
        est_out: est.out,
        est_v: EST_RULES_VERSION,
        cost: costOf(backend.id, chosenModel, u),
        ms,
        ok: !err,
        err: err ? `${err.kind}${err.status ? `_${err.status}` : ""}` : undefined,
        try: tryNo + 1,
      });
    }
}

export function cancelJob(jobId: string): boolean {
  const dropped = queue.cancelWaiting(jobId, new AIError("canceled", "중단됨"));
  const ctrl = running.get(jobId);
  if (ctrl) ctrl.abort();
  return dropped || !!ctrl;
}

export function cancelJobPrefix(prefix: string): number {
  let n = queue.cancelWaitingPrefix(prefix, new AIError("canceled", "중단됨"));
  for (const [id, ctrl] of running) if (id.startsWith(prefix)) { ctrl.abort(); n += 1; }
  return n;
}

export function registerAIService(): void {
  // 한도 폴러를 주기로 돌리지 않는다 — agy 호출 하나하나가 키체인 프롬프트를 띄운다.
  // (사용자 신고로 확인: 5분마다 프롬프트. agy 는 거의 매일 갱신돼 ACL 이 자주 무효화된다.)
  ipcMain.handle("ai:stream", async (e: IpcMainInvokeEvent, raw: AIJobInput) =>
    runAIJob(raw, (delta) => {
      if (!e.sender.isDestroyed()) e.sender.send("ai:delta", { jobId: raw?.jobId, delta });
    }),
  );


  // 취소 (H6) — 대기 중이면 큐에서 빼고, 실행 중이면 fetch 를 끊는다.
  ipcMain.handle("ai:cancel", (_e, jobId: string) => cancelJob(jobId));

  ipcMain.handle("ai:estimate", async (_e, raw: AIJobInput) => {
    const job = normalizeJob(raw);
    const systemText = job.system ?? promptFor(job.feature).system;
    const { backend } = await resolveBackendFor(job).catch(() => resolveBackend());
    const est = estimate(estimateParts(job), { backend: backend.id, systemText, feature: job.feature });
    return { ...est, calls: 1, backend: backend.id, bias: allBias() };
  });

  // 자가 진단 한 방 — 백엔드·키·차단기·큐를 한 번에 찍는다.
  ipcMain.handle("ai:status", async () => {
    const s = await readSettings();
    const { backend, provider, model } = await resolveBackend();
    return {
      backend: await backend.info(),
      backendSetting: s.ai?.backend ?? "auto",
      provider,
      model,
      keys: await secretsPresent(),
      breakers: breaker.snapshot(),
      queue: queue.stats,
      running: [...running.keys()],
      estimateBias: allBias(),
      agy: { health: await agyHealth(), pool: await poolStats("translate"), quota: quotaSnapshot() },
    };
  });

  // ── agy 전용 ──────────────────────────────────────────────────
  ipcMain.handle("agy:probe", async () => {
    // **agyHealth(true) 로 확인해야 결과가 캐시에 남는다.** probeAgy() 를 직접 부르면
    // 값은 돌아오지만 저장이 안 돼 바로 뒤 ai:status 가 다시 "아직 확인 전" 을 준다 —
    // 사용자 눈에는 "다시 확인" 버튼이 아무 일도 안 하는 것으로 보인다(사용자 신고).
    invalidateAgyHealth();
    const h = await agyHealth(true);
    return { ...h, buckets: quotaSnapshot().buckets };
  });
  // 앱 안에서는 로그인이 불가능하다 — 인가 코드를 stdin 으로 넣을 수 없다(실측).
  // 터미널을 대신 열어 주고 돌아와서 재확인하게 한다.
  ipcMain.handle("agy:openTerminal", async () => {
    const { spawn } = await import("node:child_process");
    if (process.platform === "darwin") spawn("open", ["-a", "Terminal"], { detached: true, stdio: "ignore" }).unref();
    else return { ok: false, error: "macOS 에서만 지원합니다. 터미널에서 `agy` 를 실행하세요." };
    return { ok: true };
  });
  ipcMain.handle("agy:quota", async (_e, refresh?: boolean) => (refresh ? pollQuota() : quotaSnapshot()));
  // kind="chat" 은 채팅 패널을 열 때만 — 채팅 풀(galpi-chat · --add-dir docs)을 데운다. model 생략 시 설정값.
  ipcMain.handle("agy:prewarm", async (_e, kind?: string, model?: string) =>
    prewarm(kind === "chat" ? "chat" : "translate", typeof model === "string" ? model : undefined).catch(() => null),
  );
  // 기록된 {id, home} 전부 — 계정을 바꾼 뒤에도 옛 계정 HOME 에 남긴 대화까지 지운다. 살아 있는 세션 것은 남긴다.
  ipcMain.handle("agy:gc", async (_e, dryRun?: boolean) => gcConversations({ dryRun: !!dryRun, keepIds: liveConversationIds() }));

  // ── 채팅 모델 ──────────────────────────────────────────────────
  ipcMain.handle("ai:chatModels", async (_e, refresh?: boolean) => chatModelList(!!refresh));
  ipcMain.handle("ai:setChatModel", async (_e, id: string) => {
    if (!parseRoute(id)) return false;
    await saveSettings({ ai: { chatModel: String(id).trim() } });
    return true;
  });

  // ── agy 계정 (그냥 받아쓰기·gemini-acct 와 같은 저장소) ───────────────
  ipcMain.handle("agy:accounts", async (): Promise<AgyAccount[]> =>
    listAccounts(normalizeAlias((await readSettings()).ai?.agyAccount)),
  );
  ipcMain.handle("agy:setAccount", async (_e, alias: string) => {
    if (!validAlias(alias)) return { ok: false, error: "별칭은 영문·숫자·_- 20자 이내" };
    if (alias !== MAIN_ALIAS && !existsSync(acctHome(alias))) return { ok: false, error: "없는 계정" };
    await saveSettings({ ai: { agyAccount: alias } });
    // 스페어·판정·모델 목록은 옛 HOME 기준이다. 한도 캐시는 계정별 키라 그대로 둔다.
    onAccountChanged();
    invalidateModelCache();
    return { ok: true };
  });
  ipcMain.handle("agy:login", async (_e, alias: string) => {
    const r = await openLogin(String(alias ?? ""), { cwd: agyCwd(), agyBin: findAgy() });
    if (r.ok) {
      // 사용자가 곧 로그인한다 — "미로그인" 판정·한도 캐시를 들고 있으면 돌아와서도 막힌다.
      if (normalizeAlias((await readSettings()).ai?.agyAccount) === alias) invalidateAgyHealth();
      invalidateQuotaView(alias);
    }
    return r;
  });
  ipcMain.handle("agy:quotaView", async (_e, refresh?: boolean) => quotaView(!!refresh));
  ipcMain.handle("ai:setBackend", async (_e, backend: "auto" | "agy" | "rest") => {
    await saveSettings({ ai: { backend } });
    invalidateAgyHealth();
    return true;
  });

  // 번역 시작 팝업에서 고르는 품질(low/medium). §D5 — medium 은 thinking 에 토큰을 크게 쓴다.
  ipcMain.handle("agy:setModel", async (_e, model: string) => {
    await saveSettings({ ai: { agyModel: String(model || "").slice(0, 64) || AGY_DEFAULT_MODEL } });
    return true;
  });

  ipcMain.handle("ai:resetBreaker", (_e, key?: string) => {
    breaker.reset(key);
    return true;
  });

  // 키는 렌더러로 절대 돌려주지 않는다. 저장 여부만 알려준다(H1).
  ipcMain.handle("ai:setKey", async (_e, provider: AIProvider, key: string) => {
    await setSecret(provider, key ?? "");
    breaker.reset(); // 키를 고쳤으면 그 키로 실패했던 차단을 풀어 준다
    return secretsPresent();
  });
  ipcMain.handle("ai:keyStatus", async () => secretsPresent());

  // 모델 목록 — 키는 main 이 secrets 에서 읽는다(렌더러가 들고 있지 않다).
  ipcMain.handle("ai:listModels", async (_e, provider: AIProvider) => {
    const key = await getSecret(provider);
    if (!key) return { error: "키를 먼저 입력하세요." };
    try {
      const models = await listModels(provider, key);
      noteRestModels(provider, models); // 채팅 모델 선택지에 쓴다
      return { models };
    } catch (err) {
      return { error: toAIError(err).message };
    }
  });

  // ── 문서 배치 번역 ─────────────────────────────────────────────
  ipcMain.handle("translate:doc", async (_e, opts: TranslateDocOpts) => translateDocument(opts));
  ipcMain.handle("translate:cancelDoc", async (_e, docId: string) => cancelDocTranslation(docId));
  ipcMain.handle("translate:cached", async (_e, docId: string, blocks: TrBlock[]) =>
    cachedTranslations(docId, blocks),
  );
  ipcMain.handle("translate:isRunning", async (_e, docId: string) => isTranslating(docId));
  // 사전 견적 게이트(§8 단 1) — 모델을 부르지 않는다.
  ipcMain.handle("translate:plan", async (_e, opts: TranslateDocOpts) => planTranslation(opts));

  ipcMain.handle("usage:summary", async () => usage.summary());
  ipcMain.handle("usage:forDoc", async (_e, docId: string) => usage.forDoc(docId));
  ipcMain.handle("usage:forJob", async (_e, jobId: string) => usage.forJob(jobId));
}

// 턴이 성공했다 = 로그인돼 있다. 진단용 agy 호출(=키체인 프롬프트) 없이 알 수 있는 유일한 신호다.
let agyOkNoted = false;
async function noteAgyOk(): Promise<void> {
  markLoggedIn();
  if (agyOkNoted) return;
  agyOkNoted = true;
  const s = await readSettings();
  if (!s.ai?.agyOk) await saveSettings({ ai: { agyOk: true } });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AIError("canceled", "중단됨"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function listModels(provider: AIProvider, key: string): Promise<string[]> {
  if (provider === "gemini") {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${key}`);
    if (!r.ok) throw new AIError(r.status === 401 || r.status === 403 ? "auth" : "server", `오류 ${r.status}`, r.status);
    const j = (await r.json()) as any;
    return (j.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m: any) => String(m.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
  }
  if (provider === "openai") {
    const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new AIError(r.status === 401 || r.status === 403 ? "auth" : "server", `오류 ${r.status}`, r.status);
    const j = (await r.json()) as any;
    return (j.data ?? [])
      .map((m: any) => m.id as string)
      .filter((id: string) => /^(gpt|o\d|chatgpt)/i.test(id))
      .sort();
  }
  const r = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  if (!r.ok) throw new AIError(r.status === 401 || r.status === 403 ? "auth" : "server", `오류 ${r.status}`, r.status);
  const j = (await r.json()) as any;
  return (j.data ?? []).map((m: any) => m.id as string).filter(Boolean);
}
