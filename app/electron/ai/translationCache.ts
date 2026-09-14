// 번역 캐시 (PLAN-AI §4.2, D14·D23) — docs/<doc_id>/ai/translations.json
//
// **키는 블록 id 가 아니라 텍스트 해시다.** 블록 id 는 읽기 순서 인덱스라(build_document.py:97)
// 재추출 때 앞에서 블록 하나만 늘어도 뒤가 전부 밀린다. 텍스트가 같으면 번역도 같다.
//
// 키에 들어가는 것: 정규화 텍스트 · 대상언어 · 모델 · 프롬프트 버전 · **마스킹 규칙 버전**.
// 마스킹 규칙이 바뀌면 같은 원문이라도 모델이 보는 텍스트가 달라지므로 캐시가 무효다(D23).
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { docAiDir } from "../paths";
import { atomicWriteJson } from "../settings";
import { MASK_RULES_VERSION } from "./segment";

export interface CachedSpan {
  start: number;
  end: number;
  ko: string;
}

export interface CacheEntry {
  ko: string;
  spans?: CachedSpan[]; // 문장 정렬 결과(원문 좌표)
  coverage?: number;
  model: string;
  ts: string;
  in: number;
  out: number;
}

export interface CacheContext {
  lang: string; // "ko"
  model: string;
  promptVersion: string;
}

const MAX_ENTRIES = 6000; // 대략 논문 20편분. 넘으면 오래된 것부터 버린다.

// 공백만 다른 텍스트를 같은 것으로 본다. 이 함수를 바꾸면 캐시가 전량 무효다.
export function normalizeText(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

export function cacheKey(text: string, ctx: CacheContext): string {
  const material = [normalizeText(text), ctx.lang, ctx.model, ctx.promptVersion, MASK_RULES_VERSION].join(" ");
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 40);
}

interface CacheFile {
  v: 1;
  entries: Record<string, CacheEntry>;
}

export class TranslationCache {
  private entries: Record<string, CacheEntry> = {};
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();

  private constructor(private docId: string) {}

  static async open(docId: string): Promise<TranslationCache> {
    const c = new TranslationCache(docId);
    try {
      const raw = JSON.parse(await fs.readFile(c.file(), "utf8")) as CacheFile;
      if (raw && raw.v === 1 && raw.entries) c.entries = raw.entries;
    } catch {
      /* 아직 없음 */
    }
    return c;
  }

  private file(): string {
    return path.join(docAiDir(this.docId), "translations.json");
  }

  get size(): number {
    return Object.keys(this.entries).length;
  }

  get(text: string, ctx: CacheContext): CacheEntry | null {
    return this.entries[cacheKey(text, ctx)] ?? null;
  }

  has(text: string, ctx: CacheContext): boolean {
    return cacheKey(text, ctx) in this.entries;
  }

  set(text: string, ctx: CacheContext, entry: CacheEntry): void {
    this.entries[cacheKey(text, ctx)] = entry;
    this.dirty = true;
    this.schedule();
  }

  // 렌더러가 문서를 열 때 한 번에 받아 즉시 칠할 수 있게 — 블록 목록을 받아 id 로 매핑해 준다.
  lookupAll(blocks: { id: string; text: string }[], ctx: CacheContext): Record<string, CacheEntry> {
    const out: Record<string, CacheEntry> = {};
    for (const b of blocks) {
      const e = this.entries[cacheKey(b.text, ctx)];
      if (e) out[b.id] = e;
    }
    return out;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 800);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    this.evict();
    const payload: CacheFile = { v: 1, entries: this.entries };
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(docAiDir(this.docId), { recursive: true });
      await atomicWriteJson(this.file(), payload);
    });
    await this.writeChain.catch((err) => console.warn("[trcache] 쓰기 실패:", err));
  }

  // LRU 대용 — ts 오름차순으로 오래된 것부터 버린다(구버전 프롬프트 결과가 먼저 나간다).
  private evict(): void {
    const keys = Object.keys(this.entries);
    if (keys.length <= MAX_ENTRIES) return;
    keys.sort((a, b) => (this.entries[a].ts < this.entries[b].ts ? -1 : 1));
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete this.entries[k];
  }
}

// 문서별 캐시 인스턴스 재사용 — 열 때마다 파일을 다시 읽지 않게.
const open = new Map<string, Promise<TranslationCache>>();
export function cacheFor(docId: string): Promise<TranslationCache> {
  let p = open.get(docId);
  if (!p) open.set(docId, (p = TranslationCache.open(docId)));
  return p;
}
export async function closeCache(docId: string): Promise<void> {
  const p = open.get(docId);
  if (!p) return;
  open.delete(docId);
  await (await p).flush().catch(() => {});
}
