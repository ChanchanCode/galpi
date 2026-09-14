// BYOK REST 백엔드 (D2 폴백). 기존 streamProvider 를 AIBackend 경계 안으로 옮기고
// ① usage 수집(H7) ② 타입드 에러 ③ AbortSignal 취소(H6) 를 붙였다.
import fs from "node:fs/promises";
import path from "node:path";
import { docsRoot } from "../paths";
import type { AIProvider } from "../settings";
import { getSecret } from "../settings";
import { AIError, ZERO_USAGE, type AIBackend, type AIBackendInfo, type AIChunk, type AIMessage, type AIStreamOpts, type TokenUsage } from "./types";

// ── 멀티모달 대화 (채팅) ───────────────────────────────────────────────
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

type Part = { kind: "text"; text: string } | { kind: "image"; mime: string; data: string };
interface Turn {
  role: "user" | "assistant";
  parts: Part[];
}

// 이미지 경로는 **문서 폴더 안**만 읽는다 — 여기서 읽은 바이트는 외부 API 로 나간다.
// agy 쪽은 --add-dir 이 같은 경계를 건다.
async function loadTurns(messages: AIMessage[]): Promise<Turn[]> {
  const root = path.resolve(docsRoot());
  const turns: Turn[] = [];
  for (const m of messages) {
    const parts: Part[] = [];
    for (const p of m.parts ?? []) {
      if (p.type === "text") {
        if (p.text.trim()) parts.push({ kind: "text", text: p.text });
        continue;
      }
      const abs = path.resolve(p.path);
      const rel = path.relative(root, abs);
      if (!path.isAbsolute(p.path) || !rel || rel.startsWith("..") || path.isAbsolute(rel) || !IMAGE_MIMES.has(p.mime)) {
        throw new AIError("config", "첨부 이미지 경로가 올바르지 않습니다.");
      }
      let buf: Buffer;
      try {
        buf = await fs.readFile(abs);
      } catch {
        throw new AIError("config", `첨부 이미지를 읽지 못했습니다: ${path.basename(abs)}`);
      }
      if (buf.length > MAX_IMAGE_BYTES) throw new AIError("config", "첨부 이미지가 너무 큽니다(12MB).");
      parts.push({ kind: "image", mime: p.mime, data: buf.toString("base64") });
    }
    if (!parts.length) continue;
    // 같은 역할이 연달아 오면 합친다 — Anthropic 은 교대가 아니면 400, Gemini 도 교대를 기대한다.
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.parts.push(...parts);
    else turns.push({ role: m.role, parts });
  }
  // 첫 턴은 user 여야 한다(Anthropic). 앞쪽 assistant 는 버린다.
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length) throw new AIError("config", "보낼 메시지가 없습니다.");
  return turns;
}

// SSE 의 data: 라인만 뽑아내는 비동기 이터레이터.
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 이미 해제됨 */
    }
  }
}

function retryAfterMs(r: Response): number | undefined {
  const h = r.headers.get("retry-after");
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

// 오류 본문에서 사람이 읽을 한 줄만 뽑는다 — 원본 JSON 을 그대로 UI·차단기 사유에 넣으면
// 메시지가 잘려 무슨 말인지 알 수 없게 된다.
function briefError(body: string): string {
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message ?? j?.error?.type ?? j?.message;
    if (typeof m === "string" && m) return m.slice(0, 160);
  } catch {
    /* JSON 이 아니면 원문 앞부분 */
  }
  return body.replace(/\s+/g, " ").slice(0, 160);
}

// HTTP 상태 → 타입드 에러. 429 는 재시도가 아니라 차단 대상이다(H3).
async function httpError(provider: string, r: Response): Promise<AIError> {
  const body = await r.text().catch(() => "");
  const msg = briefError(body);
  // Gemini 는 잘못된 키에 401 이 아니라 400 INVALID_ARGUMENT 를 준다. 실측으로 확인.
  const keyInvalid = /api[_ ]?key not valid|API_KEY_INVALID|invalid api key|unauthenticated/i.test(body);
  if (r.status === 401 || r.status === 403 || (r.status === 400 && keyInvalid)) {
    return new AIError("auth", `${provider} 인증 실패: ${msg}`, r.status);
  }
  if (r.status === 429) {
    return new AIError("rate_limit", `${provider} 할당량/속도 제한: ${msg}`, 429, retryAfterMs(r));
  }
  if (r.status >= 500) {
    return new AIError("server", `${provider} 서버 오류 ${r.status}: ${msg}`, r.status);
  }
  return new AIError("config", `${provider} 요청 오류 ${r.status}: ${msg}`, r.status);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export class RestBackend implements AIBackend {
  readonly id = "rest" as const;
  constructor(
    private provider: AIProvider,
    private defaultModel: string,
  ) {}

  async info(): Promise<AIBackendInfo> {
    const key = await getSecret(this.provider);
    return {
      id: "rest",
      ready: !!key && !!this.defaultModel,
      provider: this.provider,
      model: this.defaultModel,
      detail: key ? "API 키 저장됨" : "API 키 없음 — 설정 → AI",
    };
  }

  async *stream(opts: AIStreamOpts): AsyncGenerator<AIChunk> {
    const key = await getSecret(this.provider);
    if (!key) throw new AIError("config", `${this.provider.toUpperCase()} API 키가 없습니다. 설정 → AI 에서 입력하세요.`);
    const model = opts.model || this.defaultModel;
    if (!model) throw new AIError("config", "모델을 선택하세요 (설정 → AI).");

    let r: Response;
    try {
      r = await this.request(key, model, opts);
    } catch (err) {
      if (err instanceof AIError) throw err; // 첨부 읽기 실패 등 — 연결 실패로 뭉개지 않는다
      const e = err as { name?: string };
      if (e?.name === "AbortError") throw new AIError("canceled", "중단됨");
      throw new AIError("network", `연결 실패: ${String(err)}`);
    }
    if (!r.ok || !r.body) throw await httpError(this.provider, r);

    const usage: TokenUsage = { ...ZERO_USAGE };
    let sawUsage = false;
    for await (const d of sseData(r.body)) {
      if (opts.signal.aborted) throw new AIError("canceled", "중단됨");
      if (!d || d === "[DONE]") continue;
      let j: any;
      try {
        j = JSON.parse(d);
      } catch {
        continue; // keepalive / 부분 라인
      }
      const text = this.extractText(j);
      if (this.extractUsage(j, usage)) sawUsage = true;
      if (text) yield { text };
    }
    if (sawUsage) yield { usage };
  }

  private async request(key: string, model: string, opts: AIStreamOpts): Promise<Response> {
    if (opts.messages?.length) return this.requestChat(key, model, opts, await loadTurns(opts.messages));
    const { system, user, signal } = opts;
    const temperature = opts.temperature ?? 0.2;
    if (this.provider === "gemini") {
      return fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ parts: [{ text: user }] }],
            // thinking 끄기 → 2.5 모델 지연 대폭 감소 (thinking 토큰은 출력으로 과금된다)
            generationConfig: { temperature, thinkingConfig: { thinkingBudget: 0 } },
          }),
        },
      );
    }
    if (this.provider === "openai") {
      return fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        signal,
        body: JSON.stringify({
          model,
          stream: true,
          temperature,
          // 이게 없으면 스트리밍에서 usage 가 아예 오지 않는다 (H7)
          stream_options: { include_usage: true },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
    }
    return fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal,
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 4096,
        temperature,
        stream: true,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
  }

  // 대화형 요청. 번역 경로(request)와 분리해 둔다 — 번역 요청 본문은 캐시·회계 실측의 전제라 건드리지 않는다.
  private requestChat(key: string, model: string, opts: AIStreamOpts, turns: Turn[]): Promise<Response> {
    const { signal } = opts;
    const system = (opts.system ?? "").trim() ? opts.system : "";
    const maxTokens = opts.maxTokens ?? 8192;
    if (this.provider === "gemini") {
      return fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents: turns.map((t) => ({
              role: t.role === "user" ? "user" : "model",
              parts: t.parts.map((p) => (p.kind === "text" ? { text: p.text } : { inline_data: { mime_type: p.mime, data: p.data } })),
            })),
            // thinkingConfig 는 넣지 않는다 — pro 계열은 budget 0 을 400 으로 거부한다.
            generationConfig: { temperature: opts.temperature ?? 0.3, maxOutputTokens: maxTokens },
          }),
        },
      );
    }
    if (this.provider === "openai") {
      // o 시리즈·gpt-5 는 temperature 를 거부하고 max_tokens 대신 max_completion_tokens 만 받는다.
      const reasoning = /^(o\d|gpt-5)/i.test(model);
      const messages: unknown[] = [];
      if (system) messages.push({ role: "system", content: system });
      for (const t of turns) {
        if (t.role === "assistant") {
          messages.push({ role: "assistant", content: t.parts.map((p) => (p.kind === "text" ? p.text : "")).join("\n") });
        } else {
          messages.push({
            role: "user",
            content: t.parts.map((p) =>
              p.kind === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mime};base64,${p.data}` } },
            ),
          });
        }
      }
      return fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        signal,
        body: JSON.stringify({
          model,
          stream: true,
          ...(reasoning ? {} : { temperature: opts.temperature ?? 0.3 }),
          max_completion_tokens: maxTokens,
          stream_options: { include_usage: true },
          messages,
        }),
      });
    }
    return fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        stream: true,
        ...(system ? { system } : {}),
        messages: turns.map((t) => ({
          role: t.role,
          content: t.parts
            .filter((p) => t.role === "user" || p.kind === "text")
            .map((p) =>
              p.kind === "text"
                ? { type: "text", text: p.text }
                : { type: "image", source: { type: "base64", media_type: p.mime, data: p.data } },
            ),
        })),
      }),
    });
  }

  private extractText(j: any): string {
    if (this.provider === "gemini") {
      return j.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    }
    if (this.provider === "openai") return j.choices?.[0]?.delta?.content ?? "";
    if (j.type === "content_block_delta" && j.delta?.type === "text_delta") return j.delta.text ?? "";
    return "";
  }

  // 제공자별 usage 를 절대 누계로 정규화해 u 에 반영. 값을 봤으면 true.
  private extractUsage(j: any, u: TokenUsage): boolean {
    // 정규화 규칙: in 은 **캐시 미적중 입력만**, out 은 **thinking 제외**.
    // 제공자마다 포함 관계가 달라서, 맞추지 않으면 비용이 이중계상된다.
    if (this.provider === "gemini") {
      const m = j.usageMetadata;
      if (!m) return false;
      const cached = num(m.cachedContentTokenCount); // promptTokenCount 에 포함되어 있다
      u.in = Math.max(0, num(m.promptTokenCount) - cached);
      u.out = num(m.candidatesTokenCount); // thoughts 는 별도 필드
      u.think = num(m.thoughtsTokenCount);
      u.cache_read = cached;
      return true;
    }
    if (this.provider === "openai") {
      const m = j.usage;
      if (!m) return false;
      const cached = num(m.prompt_tokens_details?.cached_tokens); // prompt_tokens 에 포함
      const reasoning = num(m.completion_tokens_details?.reasoning_tokens); // completion_tokens 에 포함
      u.in = Math.max(0, num(m.prompt_tokens) - cached);
      u.out = Math.max(0, num(m.completion_tokens) - reasoning);
      u.think = reasoning;
      u.cache_read = cached;
      return true;
    }
    // Anthropic 은 input_tokens 가 캐시 토큰을 **제외**한 값이라 그대로 쓴다.
    if (j.type === "message_start" && j.message?.usage) {
      const m = j.message.usage;
      u.in = num(m.input_tokens);
      u.cache_read = num(m.cache_read_input_tokens);
      u.cache_write = num(m.cache_creation_input_tokens);
      u.out = num(m.output_tokens);
      return true;
    }
    if (j.type === "message_delta" && j.usage) {
      u.out = num(j.usage.output_tokens) || u.out; // 누계값
      return true;
    }
    return false;
  }
}
