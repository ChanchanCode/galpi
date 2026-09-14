// 논문 핵심 요약 — docs/<id>/ai/summary.json. IPC: summary:get / summary:generate / summary:state, push summary:changed.
//
// 문서별 inflight 를 공유한다: 요약 탭을 보는 순간 자동 생성 + 드롭 자동 파이프라인이 같은 문서를 동시에 부르면
// 전문(수만 토큰)을 두 번 태운다.
// 문서 폴더 헬퍼(docDirOf·loadDoc)도 여기 둔다 — chat.ts·autoPipeline.ts 가 같이 쓴다.
import { BrowserWindow, ipcMain } from "electron";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { docsRoot } from "../paths";
import { atomicWriteJson, readSettings, type Settings } from "../settings";
import { DEFAULT_CHAT_MODEL, type PaperSummary, type SummaryEvent, type SummaryState } from "./chatTypes";
import { parseSummaryJson } from "./chatParse";
import { SUMMARY_REQUEST, summarySystem } from "./chatPrompts";
import { buildPaperContext, loadDocumentCached, loadFormulaEdits } from "./paperContext";
import { PRIORITY_INTERACTIVE } from "./queue";
import { runAIJob } from "./service";

type WireError = { kind: string; message: string };

/** docId → 문서 폴더 절대경로. 경로 구분자·".."·NUL 을 막고, 정규화 결과가 docs 바로 아래인지 확인한다. */
export function docDirOf(docId: unknown): string | null {
  if (typeof docId !== "string" || !docId || docId.length > 200 || /[\\/\0]/.test(docId) || docId === "." || docId === "..") return null;
  const root = path.resolve(docsRoot());
  const dir = path.resolve(root, docId);
  return path.dirname(dir) === root ? dir : null;
}

/** 문서 폴더 안 상대경로 → 절대경로. 탈출(../, 절대경로)이면 null. */
export function resolveInDoc(docDir: string, rel: unknown): string | null {
  if (typeof rel !== "string" || !rel || rel.length > 512 || rel.includes("\0") || path.isAbsolute(rel)) return null;
  const abs = path.resolve(docDir, rel);
  return abs.startsWith(docDir + path.sep) ? abs : null;
}

export async function loadDoc(docId: string) {
  const dir = docDirOf(docId);
  return dir ? loadDocumentCached(dir) : null;
}

/** settings.ai 의 채팅 확장 필드 — AISettings 타입에 아직 없을 수 있어 좁혀 읽는다. */
export function aiExt(s: Settings): { chatModel?: string; auto?: { translate?: boolean; summary?: boolean } } {
  return (s.ai ?? {}) as { chatModel?: string; auto?: { translate?: boolean; summary?: boolean } };
}

export async function defaultChatModel(): Promise<string> {
  const m = aiExt(await readSettings()).chatModel;
  return typeof m === "string" && m.trim() ? m.trim() : DEFAULT_CHAT_MODEL;
}

const summaryFile = (dir: string) => path.join(dir, "ai", "summary.json");

export async function readSummary(docId: string): Promise<PaperSummary | null> {
  const dir = docDirOf(docId);
  if (!dir) return null;
  try {
    const j = JSON.parse(await fs.readFile(summaryFile(dir), "utf8")) as PaperSummary;
    return j && typeof j === "object" && j.v === 1 ? j : null;
  } catch {
    return null;
  }
}

export async function summaryMtime(docId: string): Promise<number> {
  const dir = docDirOf(docId);
  if (!dir) return 0;
  return fs.stat(summaryFile(dir)).then((s) => s.mtimeMs, () => 0);
}

function broadcast(e: SummaryEvent): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("summary:changed", e);
}

type GenResult = { summary?: PaperSummary; error?: WireError };
const inflight = new Map<string, Promise<GenResult>>();
const lastError = new Map<string, WireError>();

export async function summaryState(docId: string): Promise<SummaryState> {
  if (inflight.has(docId)) return "running";
  if (lastError.has(docId)) return "error";
  return (await readSummary(docId)) ? "done" : "idle";
}

export function generateSummary(
  docId: string,
  opts: { force?: boolean; model?: string; priority?: number } = {},
): Promise<GenResult> {
  const running = inflight.get(docId);
  if (running) return running; // force 여도 같은 생성을 공유한다 — 곧 새 결과가 나온다
  const p = (async (): Promise<GenResult> => {
    const dir = docDirOf(docId);
    if (!dir) return { error: { kind: "config", message: "잘못된 문서 ID" } };
    if (!opts.force) {
      const have = await readSummary(docId);
      if (have) return { summary: have };
    }
    broadcast({ docId, state: "running" });
    const fail = (error: WireError): GenResult => {
      lastError.set(docId, error);
      broadcast({ docId, state: "error", error });
      return { error };
    };
    try {
      const loaded = await loadDocumentCached(dir);
      if (!loaded) return fail({ kind: "config", message: "문서를 읽지 못했습니다." });
      const doc = loaded.doc;
      const model = (typeof opts.model === "string" && opts.model.trim()) || (await defaultChatModel());
      const { edits } = await loadFormulaEdits(dir);
      const ctx = buildPaperContext(doc, "full", null, { formulaEdits: edits });
      const res = await runAIJob(
        {
          jobId: `sum_${docId.slice(0, 40)}_${Date.now().toString(36)}`,
          feature: "summary.doc",
          route: model,
          system: summarySystem(ctx.text),
          messages: [{ role: "user", parts: [{ type: "text", text: SUMMARY_REQUEST }] }],
          text: SUMMARY_REQUEST,
          docId,
          docTitle: doc.title ?? docId,
          scope: { kind: "doc" },
          turnTimeoutMs: 300_000,
        },
        () => {},
        opts.priority ?? PRIORITY_INTERACTIVE,
      );
      if (res.error) return fail({ kind: res.error.kind, message: res.error.message });
      const raw = res.text ?? "";
      const parsed = parseSummaryJson(raw);
      const summary: PaperSummary = {
        v: 1,
        docId,
        model,
        ts: new Date().toISOString(),
        tldr: parsed?.tldr ?? "",
        question: parsed?.question ?? "",
        method: parsed?.method ?? "",
        data: parsed?.data,
        findings: parsed?.findings ?? [],
        contributions: parsed?.contributions ?? [],
        limitations: parsed?.limitations ?? [],
        keywords: parsed?.keywords ?? [],
        questions: parsed?.questions ?? [],
        ...(parsed ? {} : { raw }),
        usage: res.usage,
      };
      if (!parsed && !raw.trim()) return fail({ kind: "parse", message: "빈 응답" });
      // 생성 중에 문서가 지워졌으면 쓰지 않는다 — atomicWriteJson 이 mkdir 로 빈 문서 폴더를 되살린다.
      if (!existsSync(path.join(dir, "document.json"))) return fail({ kind: "config", message: "문서가 삭제되었습니다." });
      await atomicWriteJson(summaryFile(dir), summary);
      lastError.delete(docId);
      broadcast({ docId, state: "done" });
      return { summary };
    } catch (err) {
      return fail({ kind: "network", message: String((err as Error)?.message ?? err) });
    }
  })();
  inflight.set(docId, p);
  void p.finally(() => inflight.delete(docId));
  return p;
}

export function registerSummaryService(): void {
  ipcMain.handle("summary:get", async (_e, docId: string) => readSummary(docId));
  ipcMain.handle("summary:generate", async (_e, docId: string, opts?: { force?: boolean; model?: string }) =>
    generateSummary(docId, { force: !!opts?.force, model: typeof opts?.model === "string" ? opts.model.slice(0, 128) : undefined }),
  );
  ipcMain.handle("summary:state", async (_e, docId: string) => summaryState(docId));
}
