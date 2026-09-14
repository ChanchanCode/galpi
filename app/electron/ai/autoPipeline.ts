// PDF 추가 시 자동 파이프라인: 추출 완료 → 문서 번역 → 핵심 요약. 한 번에 한 문서, 대기열.
//
// · docId 는 추출 전에 main 이 미리 계산한다(extract.py make_doc_id 와 같은 규칙) — 라이브러리 카드와 잡을 잇기 위해서다.
// · 번역 블록은 App 의 useMemo 와 **같은 함수·같은 순서**로 고른다. 어긋나면 번역 캐시 키(원문 텍스트)가 달라져
//   사용자가 문서를 열었을 때 자동 번역분이 안 칠해진다.
// · auto-jobs.json 에는 진행 중인 잡만 남긴다(done·error 는 메모리). 재시작 시 추출이 끝난 문서만 이어서 돈다.
import { BrowserWindow, ipcMain } from "electron";
import crypto from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { PaperDocument } from "../../src/types";
import { collectTrBlocks } from "../../src/translate/trBlocks";
import { appSupportDir } from "../paths";
import { atomicWriteJson, readSettings, saveSettings, type Settings } from "../settings";
import type { AutoJobStatus } from "./chatTypes";
import { hiddenSets, loadDocumentCached } from "./paperContext";
import { PRIORITY_BATCH } from "./queue";
import { aiExt, docDirOf, generateSummary } from "./summary";
import { cancelDocTranslation, isTranslating, translateDocument, type TrBlock } from "./translateDoc";

// ── docId (pipeline/extract.py make_doc_id 와 바이트 단위 동일) ─────────────
//   h = sha1(파일)[:8]; stem = "".join(c if c.isalnum() else "-" for c in Path.stem).strip("-").lower(); f"{stem[:40]}-{h}"
// isalnum ≈ \p{L}|\p{N}. 실측(전 코드포인트 대조): Python 3.12(Unicode 15.0) 와 Electron 33(ICU 74, Unicode 15.1)은
// CJK 확장 I(U+2EBF0–U+2EE5D) 하나만 다르다 — 그 구간을 빼면 isalnum·lower 가 전부 같다.
const ALNUM = /^[\p{L}\p{N}]$/u;
const isAlnumPy312 = (c: string) => ALNUM.test(c) && !(c.codePointAt(0)! >= 0x2ebf0 && c.codePointAt(0)! <= 0x2ee5d);

/** Python 3.12 PurePath.stem — 마지막 점이 맨 앞이거나 맨 끝이면 확장자가 없다. */
export function pyStem(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(0, i) : name;
}

export function docIdStem(fileName: string): string {
  let s = "";
  for (const c of pyStem(fileName)) s += isAlnumPy312(c) ? c : "-"; // for-of = 코드포인트 단위(파이썬 문자열 순회와 같다)
  s = s.replace(/^-+|-+$/g, "").toLowerCase();
  return [...s].slice(0, 40).join("");
}

function sha1File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha1");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

/** extract.py 는 pdf_path.expanduser().resolve() 의 이름을 쓴다 → 심볼릭 링크를 따라간 실제 이름. */
export async function docIdForPdf(pdfPath: string): Promise<string> {
  const real = await fs.realpath(pdfPath);
  const h = (await sha1File(real)).slice(0, 8);
  return `${docIdStem(path.basename(real))}-${h}`;
}

// ── 설정 ────────────────────────────────────────────────────────────
export async function getAuto(): Promise<{ translate: boolean; summary: boolean }> {
  const a = aiExt(await readSettings()).auto ?? {};
  return { translate: a.translate !== false, summary: a.summary !== false };
}

// ── 번역 블록 (App.tsx useMemo: footnotes → frontMatter → pageMerge → collectTrBlocks) ─────
export function autoTrBlocks(doc: PaperDocument): TrBlock[] {
  const { footnotes, frontMatter, merge } = hiddenSets(doc.blocks);
  return collectTrBlocks(doc, {
    pulled: footnotes.pulled,
    frontIds: frontMatter.ids,
    frontStartId: frontMatter.startId,
    merge,
  }).map((b) => ({ id: b.id, text: b.text, kind: b.kind, page: b.page }));
}

// ── 상태 ────────────────────────────────────────────────────────────
const jobs = new Map<string, AutoJobStatus>();
const expecting = new Set<string>(); // 추출 중 — autoOnExit 가 올 문서
const queue: string[] = [];
const aborted = new Set<string>(); // 처리 중에 삭제된 문서
let current: string | null = null;
// 한도·인증·차단기·설정 오류면 요약을 태워 봐야 같은 이유로 실패한다.
const STOP_KINDS = new Set(["rate_limit", "auth", "breaker", "config"]);

const jobsFile = () => path.join(appSupportDir(), "auto-jobs.json");

let lastSent = 0;
let sendTimer: ReturnType<typeof setTimeout> | null = null;
function broadcastNow(): void {
  if (sendTimer) {
    clearTimeout(sendTimer);
    sendTimer = null;
  }
  lastSent = Date.now();
  const payload = Object.fromEntries(jobs);
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("auto:changed", payload);
}
// 진행 델타는 200ms 스로틀(앞·뒤 가장자리) — 배치마다 전체 map 을 쏘면 라이브러리가 매번 다시 그린다.
function broadcastThrottled(): void {
  const wait = 200 - (Date.now() - lastSent);
  if (wait <= 0) return broadcastNow();
  if (!sendTimer) sendTimer = setTimeout(broadcastNow, wait);
}

let writeChain: Promise<unknown> = Promise.resolve();
function persist(): void {
  const list = [...jobs.values()]
    .filter((j) => j.stage === "extracting" || j.stage === "translate" || j.stage === "summary")
    .map((j) => ({ docId: j.docId, stage: j.stage }));
  writeChain = writeChain
    .then(() => atomicWriteJson(jobsFile(), { v: 1, jobs: list }))
    .catch((err) => console.warn("[auto] auto-jobs.json 쓰기 실패:", err));
}

function setJob(docId: string, patch: Omit<AutoJobStatus, "docId">): void {
  jobs.set(docId, { docId, ...patch });
  persist();
  broadcastNow();
}

function dropJob(docId: string): void {
  if (!jobs.delete(docId)) return;
  persist();
  broadcastNow();
}

async function readStatusState(docId: string): Promise<string | null> {
  const dir = docDirOf(docId);
  if (!dir) return null;
  try {
    const st = JSON.parse(await fs.readFile(path.join(dir, "status.json"), "utf8")) as { state?: string };
    return st?.state ?? null;
  } catch {
    // status.json 이 없는 레거시 문서는 document.json 이 있으면 done 으로 본다(docs:list 와 같은 규칙)
    return existsSync(path.join(dir, "document.json")) ? "done" : null;
  }
}

// ── main.ts 훅 ───────────────────────────────────────────────────────
/** pipeline:extract 가 새 PDF 를 큐에 넣었을 때. */
export function autoOnQueued(docId: string): void {
  if (!docDirOf(docId)) return;
  expecting.add(docId);
  void getAuto()
    .then((a) => {
      if (!expecting.has(docId)) return; // 그새 끝났다
      if (!a.translate && !a.summary) return;
      if (current === docId || queue.includes(docId)) return;
      setJob(docId, { stage: "extracting" });
    })
    .catch(() => {});
}

/** 추출 자식 프로세스 종료(새 추출만). */
export function autoOnExit(docId: string, code: number | null): void {
  if (!expecting.delete(docId)) return;
  void (async () => {
    const state = await readStatusState(docId);
    const a = await getAuto();
    if (code !== 0 || state !== "done" || (!a.translate && !a.summary)) {
      // 추출 실패는 라이브러리 카드가 이미 status.json 으로 보여 준다 — 여기서 오류 점을 겹쳐 띄우지 않는다.
      dropJob(docId);
      return;
    }
    enqueue(docId, a.translate ? "translate" : "summary");
  })().catch((err) => console.warn("[auto] 종료 처리 실패:", err));
}

/** 문서 삭제 — 대기열에서 빼고, 처리 중이면 번역을 끊는다(요약은 저장 직전 document.json 확인으로 막힌다). */
export function autoOnDeleted(docId: string): void {
  expecting.delete(docId);
  const i = queue.indexOf(docId);
  if (i >= 0) queue.splice(i, 1);
  if (current === docId) {
    aborted.add(docId);
    cancelDocTranslation(docId);
  }
  dropJob(docId);
}

function enqueue(docId: string, stage: "translate" | "summary"): void {
  if (current === docId || queue.includes(docId)) return;
  queue.push(docId);
  setJob(docId, { stage });
  void pump();
}

let pumping = false;
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const docId = queue.shift()!;
      current = docId;
      try {
        await processDoc(docId);
      } catch (err) {
        if (!aborted.has(docId)) setJob(docId, { stage: "error", error: String((err as Error)?.message ?? err) });
      } finally {
        aborted.delete(docId);
        current = null;
      }
    }
  } finally {
    pumping = false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function processDoc(docId: string): Promise<void> {
  const a = await getAuto();
  const dir = docDirOf(docId);
  const loaded = dir ? await loadDocumentCached(dir) : null;
  if (!loaded) return setJob(docId, { stage: "error", error: "문서를 읽지 못했습니다." });
  const doc = loaded.doc;
  const docTitle = doc.title ?? doc.doc_id ?? docId;
  let trFailed: string | undefined;

  if (a.translate) {
    const blocks = autoTrBlocks(doc);
    setJob(docId, { stage: "translate", done: 0, total: blocks.length });
    // 사용자가 그 문서를 열어 이미 번역을 돌리고 있으면 끝나길 기다린다 — 겹치면 "이미 번역 중" 오류로 끝난다.
    // 기다린 뒤 다시 돌려도 캐시 적중이라 비용이 없다.
    while (isTranslating(docId) && !aborted.has(docId)) await sleep(1500);
    if (aborted.has(docId)) return;
    if (blocks.length) {
      const run = () =>
        translateDocument({
          docId,
          docTitle,
          blocks,
          onProgress: (pr) => {
            const j = jobs.get(docId);
            if (!j || j.stage !== "translate") return;
            j.done = pr.cached + pr.done;
            j.total = pr.total;
            broadcastThrottled();
          },
        });
      let p = await run();
      // 대기 확인과 시작 사이에 렌더러가 번역을 시작했으면 "이미 번역 중" — 끝나길 기다렸다 한 번 더.
      for (let k = 0; k < 3 && p.state === "error" && p.error?.kind === "config" && isTranslating(docId) && !aborted.has(docId); k++) {
        while (isTranslating(docId) && !aborted.has(docId)) await sleep(1500);
        if (!aborted.has(docId)) p = await run();
      }
      if (aborted.has(docId)) return;
      if (p.state === "canceled") return dropJob(docId); // 사용자가 번역을 멈췄다 — 요약도 돌리지 않는다
      if (p.error && STOP_KINDS.has(p.error.kind)) return setJob(docId, { stage: "error", error: p.error.message, done: p.cached + p.done, total: p.total });
      if (p.state === "error") trFailed = p.error?.message ?? "번역 실패";
    }
  }

  if (a.summary) {
    setJob(docId, { stage: "summary" });
    const r = await generateSummary(docId, { priority: PRIORITY_BATCH });
    if (aborted.has(docId)) return;
    if (r.error) return setJob(docId, { stage: "error", error: r.error.message });
  }

  setJob(docId, trFailed ? { stage: "error", error: trFailed } : { stage: "done" });
}

async function resume(): Promise<void> {
  let list: { docId?: unknown }[] = [];
  try {
    const j = JSON.parse(await fs.readFile(jobsFile(), "utf8")) as { jobs?: { docId?: unknown }[] };
    list = Array.isArray(j?.jobs) ? j.jobs : [];
  } catch {
    return;
  }
  const a = await getAuto();
  for (const it of list) {
    const docId = it?.docId;
    if (typeof docId !== "string" || !docDirOf(docId) || jobs.has(docId) || expecting.has(docId)) continue;
    // 지난 실행에서 추출 도중 꺼졌으면 status 는 extracting/error — 이어갈 수 없다(사용자가 '다시 추출').
    if ((await readStatusState(docId)) !== "done") continue;
    if (!a.translate && !a.summary) continue;
    enqueue(docId, a.translate ? "translate" : "summary");
  }
  persist(); // 이어가지 않은 항목을 파일에서 지운다
}

export function registerAutoPipeline(): void {
  ipcMain.handle("auto:status", () => Object.fromEntries(jobs));
  ipcMain.handle("ai:auto", async (_e, patch?: { translate?: boolean; summary?: boolean }) => {
    const cur = await getAuto();
    if (!patch || typeof patch !== "object") return cur;
    const next = {
      translate: typeof patch.translate === "boolean" ? patch.translate : cur.translate,
      summary: typeof patch.summary === "boolean" ? patch.summary : cur.summary,
    };
    // saveSettings 는 ai 를 한 단계만 병합한다 → auto 는 통째로 보낸다.
    await saveSettings({ ai: { auto: next } } as unknown as Settings);
    return next;
  });
  // UI 가 먼저 뜨게 잠시 뒤에 — 재개하자마자 agy 를 띄우면 첫 화면이 버벅인다.
  setTimeout(() => void resume().catch((err) => console.warn("[auto] 재개 실패:", err)), 4000).unref?.();
}
