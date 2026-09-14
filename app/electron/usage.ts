// 사용량 원장 (PLAN-AI §4.1) — <appData>/Galpi/usage.jsonl, NDJSON append-only.
//
// 규칙:
//  · 프롬프트·응답 **텍스트는 절대 저장하지 않는다**. 미공개 논문 본문이다. 글자수만 남긴다.
//  · doc_title 은 비정규화 스냅샷 — 문서를 지워도 원장이 읽힌다.
//  · cost 는 기록 시점 단가로 확정. 소급 재계산 금지.
//  · SQLite 안 쓴다(네이티브 모듈 0개 유지). 연 10MB 규모라 전체 스캔 수십 ms.
import { BrowserWindow } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { docAiDir, usageLedgerPath } from "./paths";
import { atomicWriteJson } from "./settings";
import { EST_RULES_VERSION, observe, observeOut } from "./ai/estimate";
import type { TokenUsage } from "./ai/types";

export interface UsageScope {
  kind: "selection" | "blocks" | "pages" | "section" | "doc";
  block_ids?: [string, string];
  n_blocks?: number;
  pages?: [number, number];
  section_id?: string;
}

export interface UsageRecord {
  v: 1;
  id: string;
  ts: string;
  job_id: string;
  doc_id: string;
  doc_title: string;
  feature: string;
  scope: UsageScope;
  backend: "agy" | "rest";
  provider: string;
  model: string;
  usage: TokenUsage;
  in_chars: number;
  out_chars: number;
  est_in: number;
  est_out: number;
  est_v?: number; // 견적 규칙 버전 — 다르면 EWMA 복원에 안 쓴다(계수가 바뀌면 옛 편차는 거짓이다)
  cost: { usd: number; price_v: string };
  quota_delta?: { w5h: number; weekly: number };
  ms: number;
  ok: boolean;
  err?: string;
  try: number;
}

export interface Agg {
  calls: number;
  ok: number;
  fail: number;
  in: number;
  out: number;
  think: number;
  cache_read: number;
  cache_write: number;
  usd: number;
  ms: number;
}
function zero(): Agg {
  return { calls: 0, ok: 0, fail: 0, in: 0, out: 0, think: 0, cache_read: 0, cache_write: 0, usd: 0, ms: 0 };
}
function add(a: Agg, r: UsageRecord): void {
  a.calls += 1;
  if (r.ok) a.ok += 1;
  else a.fail += 1;
  a.in += r.usage.in;
  a.out += r.usage.out;
  a.think += r.usage.think;
  a.cache_read += r.usage.cache_read;
  a.cache_write += r.usage.cache_write;
  a.usd += r.cost.usd;
  a.ms += r.ms;
}

const byDoc = new Map<string, Agg & { title: string; last: string }>();
const byDay = new Map<string, Agg>();
const byJob = new Map<string, Agg>();
const byFeature = new Map<string, Agg>();
const total = zero();
let loaded = false;

// loadLedger 가 끝난 뒤 한꺼번에 먹인다(EWMA 는 순서가 있으므로 원장 순서 그대로).
// 실행 중 기록은 service 가 직접 observe 하므로 여기서 모으지 않는다.
const biasSamples: [string, number, number][] = [];
const outBiasSamples: [string, number, number][] = [];
let loading = false;

function ingest(r: UsageRecord): void {
  add(total, r);
  if (loading && r.ok && r.est_in > 0 && r.usage.in > 0) biasSamples.push([r.backend, r.est_in, r.usage.in]);
  if (loading && r.ok && r.est_out > 0 && r.usage.out > 0 && r.est_v === EST_RULES_VERSION)
    outBiasSamples.push([r.feature, r.est_out, r.usage.out + r.usage.think]);
  const day = r.ts.slice(0, 10);
  if (!byDay.has(day)) byDay.set(day, zero());
  add(byDay.get(day)!, r);
  if (!byJob.has(r.job_id)) byJob.set(r.job_id, zero());
  add(byJob.get(r.job_id)!, r);
  if (!byFeature.has(r.feature)) byFeature.set(r.feature, zero());
  add(byFeature.get(r.feature)!, r);
  if (r.doc_id) {
    let d = byDoc.get(r.doc_id);
    if (!d) byDoc.set(r.doc_id, (d = { ...zero(), title: r.doc_title, last: r.ts }));
    add(d, r);
    d.title = r.doc_title || d.title;
    if (r.ts > d.last) d.last = r.ts;
  }
}

// 앱 시작 시 1회 — 원장을 통째로 읽어 인메모리 Map 으로.
export async function loadLedger(): Promise<void> {
  if (loaded) return;
  loaded = true;
  loading = true;
  let raw: string;
  try {
    raw = await fs.readFile(usageLedgerPath(), "utf8");
  } catch {
    loading = false;
    return; // 아직 원장 없음
  }
  let bad = 0;
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      ingest(JSON.parse(s) as UsageRecord);
    } catch {
      bad += 1;
    }
  }
  if (bad) console.warn(`[usage] 원장에서 해석 못 한 줄 ${bad}개(무시).`);
  // 견적 EWMA 보정계수를 원장에서 되살린다 — 재시작해도 견적 정확도가 리셋되지 않게.
  for (const [backend, estIn, actIn] of biasSamples) observe(backend, estIn, actIn);
  biasSamples.length = 0;
  for (const [feature, estOut, actOut] of outBiasSamples) observeOut(feature, estOut, actOut);
  outBiasSamples.length = 0;
  loading = false;
}

// 알림 디바운스 + 문서별 파생 캐시 지연 기록.
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
const dirtyDocs = new Set<string>();
function scheduleFlush(): void {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("usage:changed");
    }
    const docs = [...dirtyDocs];
    dirtyDocs.clear();
    void Promise.all(docs.map((d) => writeDocCache(d)));
  }, 200);
}

async function writeDocCache(docId: string): Promise<void> {
  const d = byDoc.get(docId);
  if (!d) return;
  try {
    await fs.mkdir(docAiDir(docId), { recursive: true });
    await atomicWriteJson(path.join(docAiDir(docId), "usage.json"), { v: 1, ...d });
  } catch {
    /* 문서 폴더가 사라졌을 수 있다 — 원장이 원본이므로 무시 */
  }
}

// append 직렬화 — 줄이 섞이면 원장 전체가 못 읽는 줄이 된다.
let appendChain: Promise<unknown> = Promise.resolve();

export function record(r: UsageRecord): Promise<void> {
  ingest(r);
  if (r.doc_id) dirtyDocs.add(r.doc_id);
  scheduleFlush();
  const line = JSON.stringify(r) + "\n";
  const p = appendChain.then(async () => {
    await fs.mkdir(path.dirname(usageLedgerPath()), { recursive: true });
    await fs.appendFile(usageLedgerPath(), line, "utf8");
  });
  appendChain = p.catch((err) => console.warn("[usage] 원장 기록 실패:", err));
  return appendChain as Promise<void>;
}

export interface UsageSummary {
  total: Agg;
  today: Agg;
  byFeature: Record<string, Agg>;
  byDoc: Record<string, Agg & { title: string; last: string }>;
  days: Record<string, Agg>;
}

function todayKey(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function summary(): UsageSummary {
  return {
    total: { ...total },
    today: { ...(byDay.get(todayKey()) ?? zero()) },
    byFeature: Object.fromEntries([...byFeature].map(([k, v]) => [k, { ...v }])),
    byDoc: Object.fromEntries([...byDoc].map(([k, v]) => [k, { ...v }])),
    days: Object.fromEntries([...byDay].map(([k, v]) => [k, { ...v }])),
  };
}

export function forDoc(docId: string): (Agg & { title: string; last: string }) | null {
  const d = byDoc.get(docId);
  return d ? { ...d } : null;
}

export function forJob(jobId: string): Agg | null {
  const a = byJob.get(jobId);
  return a ? { ...a } : null;
}

// 로컬 ISO (앞 10자로 날짜 prefix 매칭이 되도록 UTC 가 아니라 로컬).
export function localIso(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(off) / 60));
  const om = p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}:${om}`;
}
