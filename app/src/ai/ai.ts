// AI 제공자 설정 모델 — 여러 제공자(Gemini/OpenAI/Anthropic)의 API 키·선택 모델을 보관.
// 번역(및 향후 AI 기능)이 이 설정을 따른다. 모델 목록은 제공자 API 에서 직접 가져온다(main).

export type AIProvider = "gemini" | "openai" | "anthropic";

export interface AIConfig {
  provider: AIProvider;
  keys: Record<AIProvider, string>;
  models: Partial<Record<AIProvider, string>>; // 제공자별 선택 모델
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
  keys: { gemini: "", openai: "", anthropic: "" },
  models: { gemini: "gemini-2.5-flash-lite" },
};

// 옛 translation({apiKey,model}, Gemini 전용) → AIConfig 마이그레이션.
export function migrateAI(
  ai: Partial<AIConfig> | undefined,
  legacy: { apiKey?: string; model?: string } | undefined,
): AIConfig {
  if (ai?.provider) {
    return {
      provider: ai.provider,
      keys: { ...DEFAULT_AI.keys, ...(ai.keys ?? {}) },
      models: { ...DEFAULT_AI.models, ...(ai.models ?? {}) },
    };
  }
  const m = legacy?.model && legacy.model !== "gemini-2.0-flash" ? legacy.model : "gemini-2.5-flash-lite";
  return {
    provider: "gemini",
    keys: { ...DEFAULT_AI.keys, gemini: legacy?.apiKey ?? "" },
    models: { ...DEFAULT_AI.models, gemini: m },
  };
}
