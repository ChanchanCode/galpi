// AI 채팅 세션 — 문서별 저장(docs/<id>/ai/chats/<sessionId>.json). IPC 는 SPEC-CHAT §2.1 표와 1:1.
//
// 전송 한 번의 길:
//   user 메시지 즉시 저장 → 문맥·대화 조립 → runAIJob(route 고정, 델타는 요청한 창에만) → assistant 저장(done/error/canceled)
// 모델 호출 동안에는 세션 잠금을 잡지 않는다 — 그 사이 제목 변경 같은 쓰기가 막히면 안 된다.
// 대신 모든 쓰기는 "잠금 안에서 읽고-고치고-쓰기"라 서로 덮어쓰지 않는다.
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type NativeImage } from "electron";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "../settings";
import {
  DEFAULT_CHAT_MODEL,
  type AttachmentUpload,
  type ChatAttachment,
  type ChatContextMode,
  type ChatMessage,
  type ChatQuote,
  type ChatSendInput,
  type ChatSendResult,
  type ChatSession,
  type ChatSessionMeta,
} from "./chatTypes";
import { autoTitle, buildChatMessages, IMAGE_EXT, sniffImage } from "./chatParse";
import { chatSystem } from "./chatPrompts";
import { buildPaperContext, loadDocumentCached, loadFormulaEdits } from "./paperContext";
import { cancelJob, runAIJob } from "./service";
import { defaultChatModel, docDirOf, readSummary, resolveInDoc, summaryMtime } from "./summary";

const MAX_ATTACH_BYTES = 12 * 1024 * 1024;
const MAX_EDGE = 1600; // 캡처 긴 변 상한 — 레티나 2배 캡처를 그대로 보내면 이미지 토큰이 4배다
const NEW_TITLE = "새 대화";
const CONTEXTS: ChatContextMode[] = ["full", "summary", "none"];

const chatsDir = (docDir: string) => path.join(docDir, "ai", "chats");
const validSid = (sid: unknown): sid is string => typeof sid === "string" && /^s_[a-z0-9]{4,24}$/.test(sid);
const nowIso = () => new Date().toISOString();
const rid = (p: string) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

function sessionFile(docId: string, sid: string): string | null {
  const dir = docDirOf(docId);
  return dir && validSid(sid) ? path.join(chatsDir(dir), `${sid}.json`) : null;
}

function metaOf(s: ChatSession): ChatSessionMeta {
  return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, model: s.model, n: s.messages.length };
}

async function readSession(docId: string, sid: string): Promise<ChatSession | null> {
  const file = sessionFile(docId, sid);
  if (!file) return null;
  try {
    const s = JSON.parse(await fs.readFile(file, "utf8")) as ChatSession;
    if (!s || s.v !== 1 || !Array.isArray(s.messages)) return null;
    return { ...s, id: sid, docId };
  } catch {
    return null;
  }
}

// 세션별 쓰기 직렬화. 키 = 파일 경로.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}

/** 잠금 안에서 읽고-고치고-쓴다. mutate 가 false 를 주면 쓰지 않는다. 세션이 없거나 문서가 지워졌으면 null. */
async function mutateSession(
  docId: string,
  sid: string,
  mutate: (s: ChatSession) => boolean | void,
): Promise<ChatSession | null> {
  const file = sessionFile(docId, sid);
  if (!file) return null;
  return withLock(file, async () => {
    const s = await readSession(docId, sid);
    if (!s) return null;
    if (mutate(s) === false) return s;
    await writeSession(docId, s);
    return s;
  });
}

async function writeSession(docId: string, s: ChatSession): Promise<void> {
  const dir = docDirOf(docId)!;
  // 문서가 지워졌는데 atomicWriteJson 의 mkdir 로 빈 문서 폴더를 되살리면 안 된다.
  if (!existsSync(path.join(dir, "document.json"))) throw new Error("문서가 삭제되었습니다.");
  await atomicWriteJson(path.join(chatsDir(dir), `${s.id}.json`), s);
}

// ── 입력 정리(렌더러 값은 믿지 않는다) ─────────────────────────────────
function cleanModel(m: unknown): string | undefined {
  if (typeof m !== "string") return undefined;
  const t = m.trim().slice(0, 128);
  return /^(agy:[\w.\-]+|rest:(gemini|openai|anthropic):[\w.\-:/]+)$/.test(t) ? t : undefined;
}
const cleanContext = (c: unknown): ChatContextMode | undefined => (CONTEXTS.includes(c as ChatContextMode) ? (c as ChatContextMode) : undefined);
const cleanBlockId = (b: unknown) => (typeof b === "string" && /^[\w.:-]{1,40}$/.test(b) ? b : undefined);
const cleanPage = (p: unknown) => (typeof p === "number" && Number.isInteger(p) && p > 0 && p < 100000 ? p : undefined);
function cleanSource(src: unknown): { blockId?: string; page?: number } | undefined {
  if (!src || typeof src !== "object") return undefined;
  const o = src as { blockId?: unknown; page?: unknown };
  const out = { blockId: cleanBlockId(o.blockId), page: cleanPage(o.page) };
  return out.blockId || out.page ? out : undefined;
}

function cleanQuotes(qs: unknown): ChatQuote[] {
  if (!Array.isArray(qs)) return [];
  const out: ChatQuote[] = [];
  for (const q of qs.slice(0, 12)) {
    if (!q || typeof q !== "object" || typeof q.text !== "string" || !q.text.trim()) continue;
    const origin = q.origin === "translation" || q.origin === "page" ? q.origin : "source";
    out.push({ text: q.text.slice(0, 8000), origin, blockId: cleanBlockId(q.blockId), page: cleanPage(q.page) });
  }
  return out;
}

function cleanAttachments(docDir: string, as: unknown): ChatAttachment[] {
  if (!Array.isArray(as)) return [];
  const out: ChatAttachment[] = [];
  for (const a of as.slice(0, 8)) {
    if (!a || typeof a !== "object" || !resolveInDoc(docDir, a.file)) continue;
    const ext = String(a.file).split(".").pop()?.toLowerCase() ?? "";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : ext === "png" ? "image/png" : null;
    if (!mime) continue; // 이미지 확장자가 아니면 모델에 파일을 열게 하지 않는다
    out.push({
      id: typeof a.id === "string" ? a.id.slice(0, 64) : rid("a"),
      kind: "image",
      file: String(a.file),
      mime,
      w: cleanPage(a.w),
      h: cleanPage(a.h),
      name: typeof a.name === "string" ? a.name.slice(0, 120) : undefined,
      source: cleanSource(a.source),
    });
  }
  return out;
}

// ── 문맥 (문서 mtime·요약 mtime·수식편집 mtime 키로 캐시) ─────────────────
const ctxCache = new Map<string, { key: string; text: string; chars: number; title: string }>();

async function contextFor(docId: string, mode: ChatContextMode): Promise<{ text: string; chars: number; title: string } | null> {
  const dir = docDirOf(docId);
  if (!dir) return null;
  const loaded = await loadDocumentCached(dir);
  if (!loaded) return null;
  const fe = await loadFormulaEdits(dir);
  const sm = mode === "summary" ? await summaryMtime(docId) : 0;
  const key = `${loaded.mtimeMs}|${sm}|${mode === "full" ? JSON.stringify(fe.edits) : ""}`;
  const ck = `${docId}|${mode}`;
  const hit = ctxCache.get(ck);
  if (hit && hit.key === key) return hit;
  const summary = mode === "summary" ? await readSummary(docId) : null;
  const ctx = buildPaperContext(loaded.doc, mode, summary, { formulaEdits: fe.edits });
  const entry = { key, text: ctx.text, chars: ctx.chars, title: loaded.doc.title ?? docId };
  ctxCache.delete(ck);
  ctxCache.set(ck, entry);
  if (ctxCache.size > 12) ctxCache.delete(ctxCache.keys().next().value!);
  return entry;
}

// ── 첨부 저장 ───────────────────────────────────────────────────────
async function saveImageBytes(
  docId: string,
  buf: Buffer,
  extra: { name?: string; source?: { blockId?: string; page?: number }; w?: number; h?: number },
): Promise<ChatAttachment | { error: string }> {
  const dir = docDirOf(docId);
  if (!dir || !existsSync(path.join(dir, "document.json"))) return { error: "문서를 찾을 수 없습니다." };
  if (!buf.length) return { error: "빈 이미지" };
  if (buf.length > MAX_ATTACH_BYTES) return { error: "이미지가 12MB 를 넘습니다." };
  const sniff = sniffImage(buf);
  if (!sniff) return { error: "PNG·JPEG·WEBP·GIF 만 첨부할 수 있습니다." };
  const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
  const rel = `ai/chats/att/${hash}.${IMAGE_EXT[sniff.mime]}`;
  const abs = path.join(dir, ...rel.split("/"));
  if (!existsSync(abs)) {
    // 같은 내용이면 같은 이름 — 이미 있으면 다시 쓰지 않는다(내용 주소).
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, abs);
  }
  return {
    id: rid("a"),
    kind: "image",
    file: rel,
    mime: sniff.mime,
    w: extra.w ?? sniff.w,
    h: extra.h ?? sniff.h,
    name: extra.name ? path.basename(extra.name).slice(0, 120) : undefined,
    source: cleanSource(extra.source),
  };
}

async function saveAttachment(up: AttachmentUpload): Promise<ChatAttachment | { error: string }> {
  if (!up || typeof up !== "object" || typeof up.base64 !== "string") return { error: "잘못된 첨부" };
  if (!/^image\/(png|jpeg|webp|gif)$/.test(String(up.mime))) return { error: "PNG·JPEG·WEBP·GIF 만 첨부할 수 있습니다." };
  // 디코드 전에 길이로 먼저 거른다 — 수백 MB base64 를 Buffer 로 만드는 것 자체가 부담이다.
  if (up.base64.length > Math.ceil((MAX_ATTACH_BYTES * 4) / 3) + 8) return { error: "이미지가 12MB 를 넘습니다." };
  const buf = Buffer.from(up.base64, "base64");
  return saveImageBytes(up.docId, buf, { name: typeof up.name === "string" ? up.name : undefined, source: up.source });
}

async function capture(
  e: IpcMainInvokeEvent,
  docId: string,
  rect: { x: number; y: number; width: number; height: number },
  source?: { blockId?: string; page?: number },
): Promise<ChatAttachment | { error: string }> {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return { error: "창이 없습니다." };
  const nums = [rect?.x, rect?.y, rect?.width, rect?.height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return { error: "잘못된 영역" };
  // rect 는 CSS px. 페이지 줌이 1 이 아니면 DIP 로 환산한다(capturePage 는 DIP).
  const z = e.sender.getZoomFactor() || 1;
  const [cw, ch] = win.getContentSize();
  const x0 = Math.max(0, Math.floor(rect.x * z));
  const y0 = Math.max(0, Math.floor(rect.y * z));
  const x1 = Math.min(cw, Math.ceil((rect.x + rect.width) * z));
  const y1 = Math.min(ch, Math.ceil((rect.y + rect.height) * z));
  if (x1 - x0 < 4 || y1 - y0 < 4) return { error: "영역이 너무 작습니다." };
  let img: NativeImage = await e.sender.capturePage({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  if (img.isEmpty()) return { error: "캡처 실패" };
  const size = img.getSize();
  const k = MAX_EDGE / Math.max(size.width, size.height);
  if (k < 1) img = img.resize({ width: Math.round(size.width * k), height: Math.round(size.height * k), quality: "best" });
  const out = img.getSize();
  return saveImageBytes(docId, img.toPNG(), { source, w: out.width, h: out.height });
}

// ── 전송 ─────────────────────────────────────────────────────────────
interface SendState {
  canceled: boolean;
  retry?: ReturnType<typeof setInterval>;
}
const sends = new Map<string, SendState>();

async function send(e: IpcMainInvokeEvent, input: ChatSendInput): Promise<ChatSendResult> {
  const docId = input?.docId;
  const sid = input?.sessionId;
  const dir = docDirOf(docId);
  if (!dir || !validSid(sid)) return { error: { kind: "config", message: "잘못된 세션" } };
  const jobId = String(input.jobId ?? "").slice(0, 64) || rid("chat");
  if (sends.has(jobId)) return { error: { kind: "config", message: "이미 진행 중인 요청입니다." } };
  const st: SendState = { canceled: false };
  sends.set(jobId, st);
  try {
    return await sendInner(e, input, docId, sid, dir, jobId, st);
  } finally {
    if (st.retry) clearInterval(st.retry);
    sends.delete(jobId);
  }
}

async function sendInner(
  e: IpcMainInvokeEvent,
  input: ChatSendInput,
  docId: string,
  sid: string,
  dir: string,
  jobId: string,
  st: SendState,
): Promise<ChatSendResult> {
  const settingsModel = await defaultChatModel();
  let userMessage: ChatMessage | undefined;
  let history: ChatMessage[] = [];
  let model = DEFAULT_CHAT_MODEL;
  let context: ChatContextMode = "full";
  let bad: string | null = null;

  // 1) user 메시지 즉시 저장(재생성이면 마지막 assistant 를 지우고 직전 user 를 다시 쓴다)
  const session = await mutateSession(docId, sid, (s) => {
    model = cleanModel(input.model) ?? cleanModel(s.model) ?? settingsModel;
    context = cleanContext(input.context) ?? cleanContext(s.context) ?? "full";
    s.model = model;
    s.context = context;
    if (input.regenerate) {
      while (s.messages.length && s.messages[s.messages.length - 1].role === "assistant") s.messages.pop();
      const last = s.messages[s.messages.length - 1];
      if (!last) {
        bad = "다시 생성할 질문이 없습니다.";
        return false;
      }
      userMessage = last;
      history = s.messages.slice(0, -1);
    } else {
      const text = typeof input.text === "string" ? input.text.slice(0, 100_000) : "";
      const quotes = cleanQuotes(input.quotes);
      const attachments = cleanAttachments(dir, input.attachments);
      if (!text.trim() && !quotes.length && !attachments.length) {
        bad = "보낼 내용이 없습니다.";
        return false;
      }
      history = s.messages.slice();
      userMessage = {
        id: rid("m"),
        role: "user",
        text,
        ts: nowIso(),
        ...(quotes.length ? { quotes } : {}),
        ...(attachments.length ? { attachments } : {}),
      };
      s.messages.push(userMessage);
      if (!s.title.trim() || s.title === NEW_TITLE) s.title = autoTitle(text.trim() ? text : (quotes[0]?.text ?? NEW_TITLE));
    }
    s.updatedAt = nowIso();
  }).catch((err) => {
    bad = String((err as Error)?.message ?? err);
    return null;
  });
  if (!session) return { error: { kind: "config", message: bad ?? "세션을 찾을 수 없습니다." } };
  if (bad || !userMessage) return { error: { kind: "config", message: bad ?? "보낼 내용이 없습니다." }, session: metaOf(session) };
  const um: ChatMessage = userMessage;

  // 2) 문맥·대화 조립
  const t0 = Date.now();
  let partial = "";
  let result: { text?: string; usage?: ChatMessage["usage"]; error?: { kind: string; message: string } };
  const ctx = await contextFor(docId, context);
  if (!ctx) {
    result = { error: { kind: "config", message: "문서를 읽지 못했습니다." } };
  } else if (st.canceled) {
    result = { error: { kind: "canceled", message: "중단됨" } };
  } else {
    const messages = buildChatMessages({ messages: history }, um, (f) => {
      const abs = resolveInDoc(dir, f);
      return abs && existsSync(abs) ? abs : null;
    });
    const sender = e.sender;
    result = await runAIJob(
      {
        jobId,
        feature: "chat",
        route: model,
        system: chatSystem(ctx.text),
        messages,
        text: um.text || (um.quotes ?? []).map((q) => q.text).join("\n"),
        docId,
        docTitle: typeof input.docTitle === "string" && input.docTitle ? input.docTitle.slice(0, 300) : ctx.title,
        scope: { kind: "doc" },
        turnTimeoutMs: 300_000,
      },
      (delta) => {
        partial += delta;
        if (!sender.isDestroyed()) sender.send("chat:delta", { jobId, docId, sessionId: sid, delta });
      },
    ).catch((err) => ({ error: { kind: "network", message: String((err as Error)?.message ?? err) } }));
  }

  // 3) assistant 저장 — 오류·중단이어도 남긴다(중단이면 받은 데까지)
  // 중단을 눌렀어도 답이 이미 끝까지 왔으면 done 으로 둔다.
  const canceled = !!result.error && (st.canceled || result.error.kind === "canceled");
  const message: ChatMessage = {
    id: rid("m"),
    role: "assistant",
    text: result.error ? partial : (result.text ?? partial),
    ts: nowIso(),
    model,
    ms: Date.now() - t0,
    ...(result.usage ? { usage: result.usage } : {}),
    status: canceled ? "canceled" : result.error ? "error" : "done",
    ...(result.error && !canceled ? { error: { kind: result.error.kind, message: result.error.message } } : {}),
  };
  let saved: ChatSession | null = null;
  try {
    saved = await mutateSession(docId, sid, (s) => {
      s.messages.push(message);
      s.updatedAt = nowIso();
    });
  } catch {
    saved = null; // 문서가 지워졌다 — 결과는 돌려주되 저장은 못 한다
  }
  return {
    userMessage: um,
    message,
    session: saved ? metaOf(saved) : metaOf(session),
  };
}

function cancel(jobId: string): boolean {
  const st = sends.get(jobId);
  if (!st) return cancelJob(jobId);
  st.canceled = true;
  // runAIJob 이 아직 잡을 등록하기 전(문맥 조립·백엔드 확인 중)이면 cancelJob 이 헛돈다 — 등록될 때까지 다시 시도.
  if (!cancelJob(jobId) && !st.retry) {
    st.retry = setInterval(() => {
      if (cancelJob(jobId) || !sends.has(jobId)) {
        clearInterval(st.retry);
        st.retry = undefined;
      }
    }, 150);
  }
  return true;
}

// ── IPC ──────────────────────────────────────────────────────────────
export function registerChatService(): void {
  ipcMain.handle("chat:list", async (_e, docId: string): Promise<ChatSessionMeta[]> => {
    const dir = docDirOf(docId);
    if (!dir) return [];
    let names: string[] = [];
    try {
      names = (await fs.readdir(chatsDir(dir))).filter((n) => /^s_[a-z0-9]{4,24}\.json$/.test(n));
    } catch {
      return [];
    }
    const metas: ChatSessionMeta[] = [];
    for (const n of names) {
      const s = await readSession(docId, n.slice(0, -5));
      if (s) metas.push(metaOf(s));
    }
    return metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  });

  ipcMain.handle("chat:create", async (_e, docId: string, init?: { model?: string; context?: ChatContextMode; title?: string }) => {
    const dir = docDirOf(docId);
    if (!dir || !existsSync(path.join(dir, "document.json"))) return null;
    const ts = nowIso();
    const s: ChatSession = {
      v: 1,
      id: `s_${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`,
      docId,
      title: typeof init?.title === "string" && init.title.trim() ? init.title.trim().slice(0, 120) : NEW_TITLE,
      createdAt: ts,
      updatedAt: ts,
      model: cleanModel(init?.model) ?? (await defaultChatModel()),
      context: cleanContext(init?.context) ?? "full",
      messages: [],
    };
    const file = sessionFile(docId, s.id)!;
    await withLock(file, () => writeSession(docId, s));
    return s;
  });

  ipcMain.handle("chat:load", async (_e, docId: string, sid: string) => readSession(docId, sid));

  ipcMain.handle("chat:update", async (_e, docId: string, sid: string, patch: { title?: string; model?: string; context?: ChatContextMode }) => {
    const s = await mutateSession(docId, sid, (s) => {
      let changed = false;
      if (typeof patch?.title === "string" && patch.title.trim()) {
        s.title = patch.title.trim().slice(0, 120);
        changed = true;
      }
      const m = cleanModel(patch?.model);
      if (m) { s.model = m; changed = true; }
      const c = cleanContext(patch?.context);
      if (c) { s.context = c; changed = true; }
      if (!changed) return false;
      s.updatedAt = nowIso();
    }).catch(() => null);
    return s ? metaOf(s) : null;
  });

  ipcMain.handle("chat:delete", async (_e, docId: string, sid: string) => {
    const file = sessionFile(docId, sid);
    if (!file) return false;
    return withLock(file, () => fs.unlink(file).then(() => true, () => false));
  });

  ipcMain.handle("chat:send", (e, input: ChatSendInput) => send(e, input));
  ipcMain.handle("chat:cancel", (_e, jobId: string) => (typeof jobId === "string" ? cancel(jobId) : false));
  ipcMain.handle("chat:saveAttachment", (_e, up: AttachmentUpload) =>
    saveAttachment(up).catch((err) => ({ error: String((err as Error)?.message ?? err) })),
  );
  ipcMain.handle("chat:capture", (e, docId: string, rect: { x: number; y: number; width: number; height: number }, source?: { blockId?: string; page?: number }) =>
    capture(e, docId, rect, source).catch((err) => ({ error: String((err as Error)?.message ?? err) })),
  );
  ipcMain.handle("chat:contextInfo", async (_e, docId: string, mode: ChatContextMode) => {
    const ctx = await contextFor(docId, cleanContext(mode) ?? "full");
    const chars = ctx?.chars ?? 0;
    return { chars, estTokens: Math.ceil(chars / 3.6) };
  });
}
