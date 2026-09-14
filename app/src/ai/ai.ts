// AI 제공자 설정 모델 — 제공자 선택 + 제공자별 모델.
// **API 키는 여기 없다.** 키는 main 의 secrets.json(safeStorage)에만 있고,
// 렌더러는 "저장돼 있는지" 여부(keyPresent)만 안다 (H1).
export type AIProvider = "gemini" | "openai" | "anthropic";

export interface AIConfig {
  provider: AIProvider;
  models: Partial<Record<AIProvider, string>>;
  keyPresent: Record<AIProvider, boolean>;
}

export const AI_PROVIDERS: {
  id: AIProvider;
  label: string;
  keyHint: string;
  keyUrl: string;
  note: string;
}[] = [
  { id: "gemini", label: "Gemini", keyHint: "AIza…", keyUrl: "https://aistudio.google.com/apikey", note: "무료 키 발급 가능" },
  { id: "openai", label: "OpenAI", keyHint: "sk-…", keyUrl: "https://platform.openai.com/api-keys", note: "유료" },
  { id: "anthropic", label: "Claude", keyHint: "sk-ant-…", keyUrl: "https://console.anthropic.com/settings/keys", note: "유료" },
];

export const DEFAULT_AI: AIConfig = {
  provider: "gemini",
  models: { gemini: "gemini-2.5-flash-lite" },
  keyPresent: { gemini: false, openai: false, anthropic: false },
};

// settings.json 의 ai 조각 → 렌더러 상태. 평문 키 이전은 main 이 시작 시 처리한다.
export function loadAI(ai: Partial<AIConfig> | undefined, keyPresent: Record<string, boolean>): AIConfig {
  return {
    provider: ai?.provider ?? DEFAULT_AI.provider,
    models: { ...DEFAULT_AI.models, ...(ai?.models ?? {}) },
    keyPresent: { ...DEFAULT_AI.keyPresent, ...keyPresent },
  };
}

// 사람이 읽을 오류 문구 — 종류별로 다음 행동을 알려 준다.
export function aiErrorHint(kind: string): string {
  switch (kind) {
    case "auth":
      return "API 키를 다시 확인하세요 (설정 → AI).";
    case "rate_limit":
      return "한도에 걸렸습니다. 재설정 시각까지 기다리거나 다른 제공자로 바꾸세요.";
    case "server":
      return "제공자 서버 문제입니다. 잠시 뒤 다시 시도했습니다.";
    case "network":
      return "네트워크 연결을 확인하세요.";
    case "breaker":
      return "차단기가 막았습니다. 설정 → AI 에서 재개할 수 있습니다.";
    case "config":
      return "설정 → AI 에서 제공자·키·모델을 확인하세요.";
    default:
      return "";
  }
}

// ── 설정 탭 표시용 순수 헬퍼 ─────────────────────────────────────────────
// agy 계정 별칭 — main 의 validAlias 와 같은 규칙(폴더 이름이 되므로 경로 문자를 막는다).
export const ALIAS_RE = /^[A-Za-z0-9_-]{1,20}$/;

/** 토큰 수 → "812" · "12.3k" · "1.2M". 999,500 같은 경계가 "1000k" 로 새지 않게 반올림 결과 기준으로 단위를 고른다. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const one = (x: number) => x.toFixed(1).replace(/\.0$/, "");
  if (n < 99_950) return `${one(Math.round(n / 100) / 10)}k`;
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  if (n < 99_950_000) return `${one(Math.round(n / 1e5) / 10)}M`;
  return `${Math.round(n / 1e6)}M`;
}

type AggLike = { calls: number; ok: number; fail: number; in: number; out: number; think: number; usd: number };

/** 사용량 원장의 feature(점 네임스페이스)를 설정 탭의 세 줄로 묶는다. 그 밖(기타)은 버린다 — 전체 줄에 이미 들어 있다. */
export const USAGE_GROUPS = [
  { key: "translate", label: "번역" },
  { key: "chat", label: "채팅" },
  { key: "summary", label: "요약" },
] as const;

export function groupUsage(byFeature: Record<string, AggLike>): Record<(typeof USAGE_GROUPS)[number]["key"], AggLike> {
  const zero = (): AggLike => ({ calls: 0, ok: 0, fail: 0, in: 0, out: 0, think: 0, usd: 0 });
  const out = { translate: zero(), chat: zero(), summary: zero() };
  for (const [f, a] of Object.entries(byFeature)) {
    const g = USAGE_GROUPS.find((x) => f === x.key || f.startsWith(x.key + "."));
    if (!g) continue;
    const t = out[g.key];
    t.calls += a.calls; t.ok += a.ok; t.fail += a.fail;
    t.in += a.in; t.out += a.out; t.think += a.think; t.usd += a.usd;
  }
  return out;
}

/** in·out 합(생각 토큰은 출력으로 과금되니 out 에 포함). */
export function totalTokens(a: { in: number; out: number; think: number } | undefined): number {
  return a ? a.in + a.out + a.think : 0;
}

/** 한도 상태 → 1~2단어. ok·unknown 은 표시하지 않는다. */
export function quotaWord(status: string): string | null {
  switch (status) {
    case "auth": return "로그인 필요";
    case "missing": return "agy 없음";
    case "error": return "조회 실패";
    default: return null;
  }
}

/** 재설정 시각 툴팁 — "재설정 18:30 · 2시간 5분 뒤" (오늘이 아니면 날짜 포함). */
export function fmtReset(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return undefined;
  const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  const sameDay = new Date(now).toDateString() === t.toDateString();
  const when = sameDay ? hm : `${t.getMonth() + 1}/${t.getDate()} ${hm}`;
  const min = Math.max(0, Math.round((t.getTime() - now) / 60000));
  const rel = min < 60 ? `${min}분 뒤` : min < 1440 ? `${Math.floor(min / 60)}시간 ${min % 60}분 뒤` : `${Math.floor(min / 1440)}일 ${Math.floor((min % 1440) / 60)}시간 뒤`;
  return `재설정 ${when} · ${rel}`;
}
