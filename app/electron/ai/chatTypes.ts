// 채팅 · 요약 · 자동 파이프라인 · 계정 · 모델 — main ↔ 렌더러 공용 타입 (계약 파일).
// 렌더러는 preload.ts 가 re-export 한 것을 쓴다. 필드를 바꾸면 양쪽이 같이 바뀐다.
import type { TokenUsage } from "./types";

// ── 채팅 ─────────────────────────────────────────────────────────────
export type ChatRole = "user" | "assistant";

/** 이미지 첨부. file 은 **문서 폴더 기준 상대경로**(ai/chats/att/<hash>.png 또는 assets/fig.png).
 *  렌더러 표시 URL = paperAPI.assetUrl(docId, file). */
export interface ChatAttachment {
  id: string;
  kind: "image";
  file: string;
  mime: string;
  w?: number;
  h?: number;
  name?: string;
  /** 어디서 왔나 — 원본 지면 크롭이면 page, 그림 블록이면 blockId */
  source?: { blockId?: string; page?: number };
}

/** 본문에서 끌어온 인용. origin: 리플로우 원문 / 번역 카드 / 원본 지면 텍스트층 */
export interface ChatQuote {
  text: string;
  origin: "source" | "translation" | "page";
  blockId?: string;
  page?: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  ts: string; // ISO
  quotes?: ChatQuote[];
  attachments?: ChatAttachment[];
  // assistant 전용
  model?: string; // 모델 id (ChatModelInfo.id)
  usage?: TokenUsage;
  ms?: number;
  status?: "done" | "error" | "canceled";
  error?: { kind: string; message: string };
}

/** full = 논문 전문 · summary = 요약+초록+목차 · none = 문맥 없음 */
export type ChatContextMode = "full" | "summary" | "none";

export interface ChatSession {
  v: 1;
  id: string;
  docId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  context: ChatContextMode;
  messages: ChatMessage[];
}

export interface ChatSessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  n: number; // 메시지 수
}

export interface ChatSendInput {
  docId: string;
  docTitle?: string;
  sessionId: string;
  text: string;
  quotes?: ChatQuote[];
  attachments?: ChatAttachment[];
  model?: string; // 없으면 세션 모델 → 설정 기본값
  context?: ChatContextMode; // 없으면 세션 값
  jobId: string; // 렌더러가 만든다(취소용)
  /** true 면 마지막 assistant 메시지를 지우고 직전 user 메시지로 다시 답한다. text 무시. */
  regenerate?: boolean;
}

export interface ChatSendResult {
  userMessage?: ChatMessage;
  message?: ChatMessage; // 최종 assistant 메시지(오류·중단이어도 status 로 담아 저장·반환)
  session?: ChatSessionMeta;
  error?: { kind: string; message: string };
}

/** push 채널 "chat:delta" */
export interface ChatDelta {
  jobId: string;
  docId: string;
  sessionId: string;
  delta: string;
}

/** chat:saveAttachment 입력 — 렌더러가 붙여넣기·드롭·크롭한 이미지 바이트 */
export interface AttachmentUpload {
  docId: string;
  base64: string; // data: 접두사 없는 순수 base64
  mime: string; // image/png | image/jpeg | image/webp | image/gif
  name?: string;
  source?: { blockId?: string; page?: number };
}

// ── 요약 ─────────────────────────────────────────────────────────────
/** 각 문자열 필드는 Markdown(인라인 LaTeX·[b0042] 인용 포함 가능). */
export interface PaperSummary {
  v: 1;
  docId: string;
  model: string;
  ts: string;
  tldr: string; // 3줄 이내
  question: string; // 연구 질문
  method: string; // 방법·식별 전략
  data?: string; // 데이터·표본
  findings: string[]; // 핵심 결과(숫자 포함)
  contributions: string[];
  limitations: string[];
  keywords: string[];
  questions: string[]; // 추천 질문 칩(채팅 빈 화면)
  /** JSON 파싱 실패 시 모델 원문 Markdown — UI 는 이것만 그린다 */
  raw?: string;
  usage?: TokenUsage;
}

export type SummaryState = "idle" | "running" | "done" | "error";

/** push 채널 "summary:changed" */
export interface SummaryEvent {
  docId: string;
  state: SummaryState;
  error?: { kind: string; message: string };
}

// ── 추가 시 자동 파이프라인 (추출 완료 → 번역 → 요약) ────────────────────
export type AutoStage = "extracting" | "translate" | "summary" | "done" | "error";
export interface AutoJobStatus {
  docId: string;
  stage: AutoStage;
  done?: number; // translate 단계 진행
  total?: number;
  error?: string;
}
/** push 채널 "auto:changed" → payload: Record<docId, AutoJobStatus> */

// ── 모델 ─────────────────────────────────────────────────────────────
/** id 형식: "agy:<model>" | "rest:<provider>:<model>"  (예: agy:gemini-3.8-flash-medium, rest:anthropic:claude-sonnet-4-6) */
export interface ChatModelInfo {
  id: string;
  label: string; // 짧은 표시명 (예: "Gemini 3.8 Flash Medium")
  group: "agy" | "gemini" | "openai" | "anthropic";
}
export interface ChatModelList {
  models: ChatModelInfo[];
  default: string; // 설정 ai.chatModel (없으면 agy:gemini-3.8-flash-medium)
}
export const DEFAULT_CHAT_MODEL = "agy:gemini-3.8-flash-medium";

// ── agy 계정 (그냥 받아쓰기와 같은 저장소: ~/.claude/.state/gemini-accounts/<alias>) ──
export interface AgyAccount {
  alias: string; // "main" = 실제 홈
  email: string; // 모르면 "-"
  loggedIn: boolean | null; // main 은 키체인이라 파일로 판정 불가 → null
  current: boolean;
}

/** 한도 잔량 (Gemini 버킷만). 5분 캐시, 계정별. */
export interface AgyQuotaView {
  status: "ok" | "auth" | "missing" | "error" | "unknown";
  h5?: { remaining: number; reset?: string }; // remaining 0~1
  weekly?: { remaining: number; reset?: string };
  at: number; // 조회 시각(ms). 0 = 아직 안 봄
}
