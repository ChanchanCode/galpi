// AI 설정 탭 — 제공자(Gemini/OpenAI/Claude) 선택 + API 키 + 모델 목록 직접 조회·선택.
import { useState } from "react";
import { useStore } from "../store/useStore";
import { AI_PROVIDERS } from "./ai";

export function AISettings() {
  const ai = useStore((s) => s.ai);
  const setAIProvider = useStore((s) => s.setAIProvider);
  const setAIKey = useStore((s) => s.setAIKey);
  const setAIModel = useStore((s) => s.setAIModel);

  const [models, setModels] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const provider = ai.provider;
  const meta = AI_PROVIDERS.find((p) => p.id === provider)!;
  const key = ai.keys[provider] ?? "";
  const model = ai.models[provider] ?? "";
  const list = models[provider] ?? [];

  const loadModels = async () => {
    setLoading(true);
    setErr(null);
    const r = await window.paperAPI.listModels(provider, key);
    setLoading(false);
    if (r.error || !r.models) {
      setErr(r.error ?? "불러오기 실패");
      return;
    }
    setModels((m) => ({ ...m, [provider]: r.models! }));
    if (r.models.length && !r.models.includes(model)) setAIModel(provider, r.models[0]);
  };

  return (
    <div className="ai-settings">
      <div className="typo-section">
        <span className="ctrl-label">제공자</span>
        <div className="seg">
          {AI_PROVIDERS.map((p) => (
            <button
              key={p.id}
              className={`seg-btn ${provider === p.id ? "on" : ""}`}
              onClick={() => {
                setAIProvider(p.id);
                setErr(null);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <label className="ctrl">
          <span className="ctrl-label">
            {meta.label} API 키 <span className="muted-inline">({meta.note})</span>
          </span>
          <input
            type="password"
            placeholder={meta.keyHint}
            value={key}
            onChange={(e) => setAIKey(provider, e.target.value)}
          />
        </label>
        <button className="link-btn" onClick={() => window.paperAPI.openExternal(meta.keyUrl)}>
          {meta.label} 키 발급 페이지 열기 ↗
        </button>
      </div>

      <div className="typo-section">
        <span className="ctrl-label">모델</span>
        <div className="ai-model-row">
          <select value={model} onChange={(e) => setAIModel(provider, e.target.value)}>
            {model && !list.includes(model) && <option value={model}>{model}</option>}
            {list.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {!list.length && !model && <option value="">— 모델 불러오기 —</option>}
          </select>
          <button className="seg-btn" onClick={loadModels} disabled={loading || !key}>
            {loading ? "…" : "모델 불러오기"}
          </button>
        </div>
        {err && <p className="typo-note" style={{ color: "var(--accent)" }}>모델 목록 오류: {err}</p>}
        <p className="typo-note">
          "모델 불러오기"로 {meta.label} 계정의 실제 모델 목록을 가져와 직접 고릅니다. 선택한 문장이
          {" "}{meta.label} 로 전송됩니다(미공개 논문 주의). 429/503(과부하)은 자동 1회 재시도하며,
          계속되면 다른 모델/제공자로 바꿔 보세요.
          {provider === "gemini" && " · Gemini 는 thinking 을 꺼 빠르게 응답합니다."}
        </p>
      </div>
    </div>
  );
}
