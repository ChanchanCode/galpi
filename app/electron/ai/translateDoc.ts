// 문서 배치 번역 스케줄러 (PLAN-AI §9-P2).
//
// 설계 요점:
//  · 블록 단위 캐시 — 중단은 손실이 아니라 일시정지다. 재개하면 캐시 있는 블록은 건너뛴다.
//  · **뷰포트 우선** — 렌더러가 정렬해 넘긴 순서를 그대로 따른다. 위에서부터 채우면 읽던 화면이 밀린다.
//  · 배치 동시성은 **1** — 큐 한도가 2 이므로 한 칸을 항상 선택 번역(사람이 기다리는 쪽)에 비워 둔다.
//  · 한도/차단기/인증 오류는 **남은 배치를 즉시 포기**한다. 안 그러면 남은 200블록이
//    전부 즉시 실패로 원장에 쌓인다.
import { BrowserWindow } from "electron";
import { readSettings } from "../settings";
import { promptFor } from "./prompts";
import { PRIORITY_BATCH } from "./queue";
import { parseBlocksJson, prepare, resolve, type AnchorMode } from "./segment";
import { cacheFor, type CacheContext, type CacheEntry } from "./translationCache";
import type { TokenUsage } from "./types";
import { runAIJob, cancelJobPrefix, resolvedBackendId, type AIJobResult } from "./service";
import type { BlockKind } from "./estimate";
import { estimate } from "./estimate";

export interface TrBlock {
  id: string;
  text: string;
  kind?: BlockKind;
  page?: number;
}

export interface TranslateDocOpts {
  docId: string;
  docTitle?: string;
  blocks: TrBlock[]; // 뷰포트 우선 순서로 이미 정렬돼 들어온다
  anchorMode?: AnchorMode;
  force?: boolean; // 캐시 무시(↻ 재생성)
  maxCharsPerBatch?: number;
  maxBlocksPerBatch?: number;
  /** main 안에서 부르는 쪽(자동 파이프라인)용 진행 콜백 — IPC 로는 함수가 못 넘어오니 렌더러 경로는 늘 undefined */
  onProgress?: (p: TranslateProgress) => void;
}

export interface TranslateProgress {
  docId: string;
  state: "running" | "done" | "canceled" | "error";
  total: number;
  cached: number;
  done: number;
  failed: number;
  usage: TokenUsage;
  est: { in: number; out: number };
  batches: { done: number; total: number };
  error?: { kind: string; message: string };
}

export interface TranslatedBlock {
  docId: string;
  id: string;
  ko: string;
  spans?: { start: number; end: number; ko: string }[];
  coverage?: number;
  fromCache: boolean;
}

const DEFAULT_MAX_CHARS = 3200;
const DEFAULT_MAX_BLOCKS = 12;

// 이 종류의 오류가 나면 남은 배치를 계속 던져 봐야 전부 즉시 실패한다.
const FATAL = new Set(["rate_limit", "breaker", "auth", "config", "canceled"]);

const active = new Map<string, { canceled: boolean }>();

function send(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function addUsage(dst: TokenUsage, src?: TokenUsage): void {
  if (!src) return;
  dst.in += src.in;
  dst.out += src.out;
  dst.think += src.think;
  dst.cache_read += src.cache_read;
  dst.cache_write += src.cache_write;
}

// 글자수·블록수 예산으로 자른다. 한 블록이 예산보다 크면 혼자 한 배치가 된다.
function makeBatches(blocks: TrBlock[], maxChars: number, maxBlocks: number): TrBlock[][] {
  const out: TrBlock[][] = [];
  let cur: TrBlock[] = [];
  let chars = 0;
  for (const b of blocks) {
    const n = b.text.length;
    if (cur.length && (chars + n > maxChars || cur.length >= maxBlocks)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(b);
    chars += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function cancelDocTranslation(docId: string): boolean {
  const st = active.get(docId);
  if (st) st.canceled = true;
  cancelJobPrefix(`trdoc_${docId}_`);
  return !!st;
}

export interface TranslatePlan {
  total: number;
  cached: number;
  pending: number;
  batches: number;
  est: { in: number; out: number };
  backend: string;
  model: string;
}

// 사전 견적 게이트(§8 단 1)용 — **모델을 부르지 않고** 캐시 적중분과 배치 수·토큰 견적만 낸다.
// translateDocument 와 같은 계산을 쓰도록 한 곳에 모아 둔다(견적과 실행이 갈라지면 게이트가 거짓말을 한다).
export async function planTranslation(opts: TranslateDocOpts): Promise<TranslatePlan> {
  const anchorMode: AnchorMode = opts.anchorMode ?? "full";
  const feature = anchorMode === "prefix" ? "translate.blocks.prefix" : "translate.blocks";
  const prompt = promptFor(feature);
  const ctx = await contextFor(feature);
  const cache = await cacheFor(opts.docId);
  const backend = await backendIdForEstimate();

  const pending: TrBlock[] = [];
  let cached = 0;
  let total = 0;
  for (const b of opts.blocks) {
    if (!b.text?.trim()) continue;
    total += 1;
    if (!opts.force && cache.get(b.text, ctx)) cached += 1;
    else pending.push(b);
  }
  const batches = makeBatches(
    pending,
    opts.maxCharsPerBatch ?? DEFAULT_MAX_CHARS,
    opts.maxBlocksPerBatch ?? DEFAULT_MAX_BLOCKS,
  );
  const est = estimateBatches(pending, batches.length, prompt.system, backend, feature);
  return { total, cached, pending: pending.length, batches: batches.length, est, backend, model: ctx.model };
}

// 배치마다 시스템 프롬프트(+agy 턴 오버헤드)가 다시 들어간다 — 배치 수만큼 더해야 견적이 맞는다.
function estimateBatches(
  pending: TrBlock[],
  nBatches: number,
  system: string,
  backend: string,
  feature: string,
): { in: number; out: number } {
  const est = estimate(
    pending.map((b) => ({ text: b.text, kind: b.kind ?? "para" })),
    { systemText: system, backend, feature },
  );
  if (nBatches > 1) {
    const one = estimate([], { systemText: system, backend, feature });
    est.in += (nBatches - 1) * one.in;
  }
  return est;
}

async function backendIdForEstimate(): Promise<string> {
  return resolvedBackendId();
}

export function isTranslating(docId: string): boolean {
  return active.has(docId);
}

// 캐시에 이미 있는 것만 즉시 돌려준다(문서를 열자마자 칠하기 위함).
export async function cachedTranslations(
  docId: string,
  blocks: TrBlock[],
): Promise<Record<string, CacheEntry>> {
  const ctx = await contextFor();
  const cache = await cacheFor(docId);
  return cache.lookupAll(blocks, ctx);
}

async function contextFor(feature = "translate.blocks"): Promise<CacheContext> {
  const s = await readSettings();
  const backend = s.ai?.backend ?? "auto";
  const model =
    backend === "rest"
      ? (s.ai?.models?.[(s.ai?.provider ?? "gemini") as "gemini"] ?? "gemini-2.5-flash-lite")
      : (s.ai?.agyModel ?? "gemini-3.7-flash-low");
  return { lang: "ko", model, promptVersion: promptFor(feature).version };
}

export async function translateDocument(opts: TranslateDocOpts): Promise<TranslateProgress> {
  const { docId, blocks } = opts;
  if (active.has(docId)) {
    return progressOf(docId, "error", blocks.length, 0, 0, 0, zero(), { in: 0, out: 0 }, { done: 0, total: 0 }, {
      kind: "config",
      message: "이미 번역 중입니다.",
    });
  }
  const state = { canceled: false };
  active.set(docId, state);

  const anchorMode: AnchorMode = opts.anchorMode ?? "full";
  const feature = anchorMode === "prefix" ? "translate.blocks.prefix" : "translate.blocks";
  const prompt = promptFor(feature);
  const ctx = await contextFor(feature);
  const cache = await cacheFor(docId);

  const usageTotal = zero();
  let cached = 0;
  let done = 0;
  let failed = 0;
  let err: { kind: string; message: string } | undefined;

  // 1) 캐시 적중분을 먼저 뱉는다 — 사용자는 즉시 화면을 본다.
  const pending: TrBlock[] = [];
  for (const b of blocks) {
    if (!b.text?.trim()) continue;
    const hit = opts.force ? null : cache.get(b.text, ctx);
    if (hit) {
      cached += 1;
      send("translate:block", {
        docId,
        id: b.id,
        ko: hit.ko,
        spans: hit.spans,
        coverage: hit.coverage,
        fromCache: true,
      } satisfies TranslatedBlock);
    } else {
      pending.push(b);
    }
  }

  const batches = makeBatches(pending, opts.maxCharsPerBatch ?? DEFAULT_MAX_CHARS, opts.maxBlocksPerBatch ?? DEFAULT_MAX_BLOCKS);
  // 견적은 planTranslation(사전 게이트)과 **같은 함수**를 쓴다 — 갈라지면 게이트가 거짓말을 한다.
  const est = estimateBatches(pending, batches.length, prompt.system, await resolvedBackendId(), feature);

  const emit = (st: TranslateProgress["state"], bDone: number) => {
    const p = progressOf(docId, st, blocks.length, cached, done, failed, usageTotal, est, { done: bDone, total: batches.length }, err);
    send("translate:progress", p);
    notify(opts, p);
  };
  emit("running", 0);

  // 2) 배치를 **순차로** 돌린다(동시성 1). 큐 한 칸을 선택 번역에 비워 두기 위해서다.
  for (let i = 0; i < batches.length; i++) {
    if (state.canceled) break;
    const batch = batches[i];
    const preps = new Map(batch.map((b) => [b.id, prepare(b.text)]));
    const payload = batch.map((b) => ({ id: b.id, text: preps.get(b.id)!.text }));

    const res: AIJobResult = await runAIJob(
      {
        jobId: `trdoc_${docId}_${i}`,
        feature,
        text: JSON.stringify(payload),
        docId,
        docTitle: opts.docTitle,
        scope: { kind: "blocks", n_blocks: batch.length, block_ids: [batch[0].id, batch[batch.length - 1].id] },
      },
      () => {},
      PRIORITY_BATCH,
    );

    if (res.error) {
      failed += batch.length;
      err = { kind: res.error.kind, message: res.error.message };
      if (FATAL.has(res.error.kind)) break; // 남은 배치를 던지지 않는다
      emit("running", i + 1);
      continue;
    }
    addUsage(usageTotal, res.usage);

    let parsed;
    try {
      parsed = parseBlocksJson(res.text ?? "");
    } catch (e) {
      failed += batch.length;
      err = { kind: "parse", message: `응답을 JSON 으로 못 읽었습니다: ${String(e)}` };
      emit("running", i + 1);
      continue;
    }

    const nowIso = new Date().toISOString();
    const perBlockIn = Math.round((res.usage?.in ?? 0) / Math.max(1, batch.length));
    const perBlockOut = Math.round((res.usage?.out ?? 0) / Math.max(1, batch.length));
    for (const b of batch) {
      const got = parsed.find((x) => x.id === b.id);
      if (!got) {
        failed += 1;
        continue;
      }
      const r = resolve(preps.get(b.id)!, got, b.id, anchorMode);
      if (!r.ko.trim()) {
        failed += 1;
        continue;
      }
      const entry: CacheEntry = {
        ko: r.ko,
        spans: r.spans.filter((s) => s.ok).map((s) => ({ start: s.start, end: s.end, ko: s.ko })),
        coverage: r.coverage,
        model: ctx.model,
        ts: nowIso,
        in: perBlockIn,
        out: perBlockOut,
      };
      cache.set(b.text, ctx, entry);
      done += 1;
      send("translate:block", {
        docId,
        id: b.id,
        ko: entry.ko,
        spans: entry.spans,
        coverage: entry.coverage,
        fromCache: false,
      } satisfies TranslatedBlock);
    }
    emit("running", i + 1);
  }

  await cache.flush();
  active.delete(docId);
  const final: TranslateProgress["state"] = state.canceled ? "canceled" : err && done === 0 ? "error" : "done";
  const p = progressOf(docId, final, blocks.length, cached, done, failed, usageTotal, est, {
    done: batches.length,
    total: batches.length,
  }, err);
  send("translate:progress", p);
  notify(opts, p);
  return p;
}

// 콜백 예외가 배치 루프를 끊으면 안 된다.
function notify(opts: TranslateDocOpts, p: TranslateProgress): void {
  try {
    opts.onProgress?.(p);
  } catch {
    /* 무시 */
  }
}

function zero(): TokenUsage {
  return { in: 0, out: 0, think: 0, cache_read: 0, cache_write: 0 };
}

function progressOf(
  docId: string,
  state: TranslateProgress["state"],
  total: number,
  cached: number,
  done: number,
  failed: number,
  usage: TokenUsage,
  est: { in: number; out: number },
  batches: { done: number; total: number },
  error?: { kind: string; message: string },
): TranslateProgress {
  return { docId, state, total, cached, done, failed, usage: { ...usage }, est, batches, error };
}
