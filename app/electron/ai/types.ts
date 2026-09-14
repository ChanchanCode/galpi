// AI 백엔드 경계 (PLAN-AI §3). 이 인터페이스가 지켜지면 백엔드 교체 비용이 파일 하나다.
import type { AIProvider } from "../settings";

export type AIErrorKind =
  | "config" // 키/모델 미설정
  | "auth" // 401/403
  | "rate_limit" // 429 · 할당량 소진
  | "server" // 5xx
  | "network" // 연결 실패
  | "parse" // 응답 해석 실패
  | "canceled" // 사용자가 중단
  | "breaker"; // 차단기가 막음

export class AIError extends Error {
  constructor(
    readonly kind: AIErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AIError";
  }
  toWire(): { kind: AIErrorKind; message: string; status?: number; retryAfterMs?: number } {
    return { kind: this.kind, message: this.message, status: this.status, retryAfterMs: this.retryAfterMs };
  }
}

export function toAIError(err: unknown): AIError {
  if (err instanceof AIError) return err;
  const e = err as { name?: string; message?: string };
  if (e?.name === "AbortError") return new AIError("canceled", "중단됨");
  return new AIError("network", String(e?.message ?? err));
}

// 5종이다 — cache_write 를 in 에 접으면 안 된다(Anthropic 은 1.25배 단가).
export interface TokenUsage {
  in: number;
  out: number;
  think: number;
  cache_read: number;
  cache_write: number;
}
export const ZERO_USAGE: TokenUsage = { in: 0, out: 0, think: 0, cache_read: 0, cache_write: 0 };

// 백엔드가 흘려보내는 조각. usage 는 그 시점까지의 **절대 누계**로 정규화해서 준다.
export interface AIChunk {
  text?: string;
  usage?: Partial<TokenUsage>;
}

// 멀티턴·멀티모달 입력 (채팅). image.path 는 **절대경로** — REST 는 base64 로 읽어 싣고,
// agy 는 --add-dir 안의 파일을 view_file 로 읽힌다(실측: add-dir 만 주면 권한 프롬프트 없이 읽힘).
export type AIPart = { type: "text"; text: string } | { type: "image"; path: string; mime: string };
export interface AIMessage {
  role: "user" | "assistant";
  parts: AIPart[];
}

export interface AIStreamOpts {
  system: string;
  user: string;
  model: string;
  signal: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  /** 있으면 user 대신 이걸 대화로 쓴다(마지막 원소가 이번 질문). */
  messages?: AIMessage[];
}

export interface AIBackendInfo {
  id: "agy" | "rest";
  ready: boolean;
  provider: AIProvider | "gemini-agy";
  model: string;
  detail?: string;
}

export interface AIBackend {
  readonly id: "agy" | "rest";
  info(): Promise<AIBackendInfo>;
  stream(opts: AIStreamOpts): AsyncIterable<AIChunk>;
}
