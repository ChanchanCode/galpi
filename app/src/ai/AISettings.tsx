// AI 설정 탭 — 계정 · 한도 · 사용량 · 채팅 모델 · 자동 · 엔진 · API 키 · 모델.
// **설명 문장을 두지 않는다.** 라벨·값·버튼만. 부연이 필요한 것은 title(툴팁)로 뺀다.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgyAccount, AgyQuotaView, ChatModelList } from "../../electron/preload";
import { useStore } from "../store/useStore";
import {
  AI_PROVIDERS, ALIAS_RE, USAGE_GROUPS, fmtReset, fmtTokens, groupUsage, quotaWord, totalTokens,
} from "./ai";
import "./usage.css";

type Status = Awaited<ReturnType<typeof window.paperAPI.aiStatus>>;
type Usage = Awaited<ReturnType<typeof window.paperAPI.usageSummary>>;
type Agg = Usage["total"];

// App.tsx 의 ICO 규약(24 viewBox · 1.7 획 · 둥근 끝) — 설정 행 안이라 크기만 작게.
const ICO = {
  width: 15, height: 15, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const, "aria-hidden": true,
};
const RefreshIcon = ({ spin }: { spin?: boolean }) => (
  <svg {...ICO} className={spin ? "ai-spin" : undefined}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </svg>
);

const ADD = "__add__";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function AISettings() {
  const ai = useStore((s) => s.ai);
  const setAIProvider = useStore((s) => s.setAIProvider);
  const setAIKey = useStore((s) => s.setAIKey);
  const setAIModel = useStore((s) => s.setAIModel);

  const [models, setModels] = useState<Record<string, string[]>>({});
  const [draftKey, setDraftKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // agy 기록 정리는 수 초 걸린다 — 표시가 없으면 버튼이 먹통으로 보인다(사용자 신고).
  const [gcBusy, setGcBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  const provider = ai.provider;
  const meta = AI_PROVIDERS.find((p) => p.id === provider)!;
  const model = ai.models[provider] ?? "";
  const list = models[provider] ?? [];
  const saved = ai.keyPresent[provider];

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await window.paperAPI.aiStatus());
    } catch {
      /* 진단 줄만 비는 것 — 탭 전체를 깨뜨리지 않는다 */
    }
  }, []);
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, provider, model]);

  // 키는 입력 상자에 남기지 않는다 — 저장하면 즉시 비우고 "저장됨"만 표시.
  const saveKey = async () => {
    const k = draftKey.trim();
    if (!k) return;
    await setAIKey(provider, k);
    setDraftKey("");
    setNote(null);
    void refreshStatus();
  };

  const loadModels = async () => {
    setLoading(true);
    setNote(null);
    try {
      const r = await window.paperAPI.listModels(provider);
      if (r.error || !r.models) return setNote(r.error ?? "불러오기 실패");
      setModels((m) => ({ ...m, [provider]: r.models! }));
      if (r.models.length && !r.models.includes(model)) setAIModel(provider, r.models[0]);
    } catch (e) {
      setNote(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  const agy = status?.agy;
  const breakers = Object.entries(status?.breakers ?? {}).filter(
    ([, b]) => b.trippedForMs > 0 || b.closedForSession,
  );

  return (
    <div className="ai-settings">
      <AccountQuota onChanged={refreshStatus} />
      <UsageSection />
      <ChatModelSection />
      <AutoSection />

      <div className="typo-section">
        <span className="ctrl-label">엔진</span>
        <div className="seg">
          {(["auto", "agy", "rest"] as const).map((b) => (
            <button
              key={b}
              className={`seg-btn ${(status?.backendSetting ?? "auto") === b ? "on" : ""}`}
              onClick={async () => {
                try {
                  await window.paperAPI.setAIBackend(b);
                } finally {
                  void refreshStatus();
                }
              }}
            >
              {b === "auto" ? "자동" : b === "agy" ? "구독" : "API 키"}
            </button>
          ))}
        </div>
      </div>

      <div className="typo-section">
        <span className="ctrl-label">API 키</span>
        <div className="seg">
          {AI_PROVIDERS.map((p) => (
            <button
              key={p.id}
              className={`seg-btn ${provider === p.id ? "on" : ""}`}
              onClick={() => {
                setAIProvider(p.id);
                setDraftKey("");
                setNote(null);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="ai-row">
          <input
            type="password"
            title="OS 키체인으로 암호화해 따로 보관합니다"
            placeholder={saved ? "●●●●●●●●  저장됨" : meta.keyHint}
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void saveKey()}
            onBlur={() => void saveKey()}
          />
          {saved && (
            <button
              className="seg-btn"
              title="저장된 키 삭제"
              onClick={async () => {
                await setAIKey(provider, "");
                setDraftKey("");
                void refreshStatus();
              }}
            >
              삭제
            </button>
          )}
          <button className="seg-btn" onClick={() => window.paperAPI.openExternal(meta.keyUrl)}>
            발급 ↗
          </button>
        </div>
      </div>

      <div className="typo-section">
        <span className="ctrl-label">모델</span>
        <div className="ai-row">
          <select value={model} onChange={(e) => setAIModel(provider, e.target.value)}>
            {model && !list.includes(model) && <option value={model}>{model}</option>}
            {list.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            {!list.length && !model && <option value="">—</option>}
          </select>
          <button className="seg-btn" onClick={loadModels} disabled={loading || !saved}>
            {loading ? "불러오는 중…" : "목록"}
          </button>
        </div>
      </div>

      {(note || breakers.length > 0 || status) && (
        <div className="typo-section">
          {note && <p className="ai-line warn">{note}</p>}
          {breakers.map(([k, b]) => (
            <div key={k} className="ai-row">
              <span className="ai-line warn">
                차단 {k} · {b.closedForSession ? "세션 중단" : `${Math.ceil(b.trippedForMs / 1000)}초`}
              </span>
              <button
                className="seg-btn"
                onClick={async () => {
                  try {
                    await window.paperAPI.aiResetBreaker();
                  } finally {
                    void refreshStatus();
                  }
                }}
              >
                해제
              </button>
            </div>
          ))}
          {status && (
            <div className="ai-row ai-diag">
              <p className="ai-line" title={status.backend.detail ?? ""}>
                {status.backend.id} · 큐 {status.queue.active}/{status.queue.limit}
                {agy?.pool ? ` · 웜 ${agy.pool.spares}` : ""}
              </p>
              {agy?.health.bin && (
                <button
                  className="seg-btn"
                  title="갈피가 만든 agy 대화 기록만 지웁니다"
                  disabled={gcBusy}
                  onClick={async () => {
                    setGcBusy(true);
                    try {
                      const r = await window.paperAPI.agyGc();
                      setNote(`기록 ${r.removed}개 · ${r.freedMb}MB`);
                    } catch (e) {
                      setNote(errMsg(e));
                    } finally {
                      setGcBusy(false);
                    }
                  }}
                >
                  {gcBusy ? "정리 중…" : "기록 정리"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 계정 · 한도 ────────────────────────────────────────────────────────
// 둘을 한 컴포넌트에 둔다: 계정을 바꾸면 한도가 곧바로 그 계정 것으로 다시 읽혀야 하고,
// "로그인" 버튼은 계정 파일 판정(loggedIn=false)과 한도 조회 결과(auth) 둘 다로 띄운다(main 은 파일로 판정 불가).
function AccountQuota({ onChanged }: { onChanged: () => void }) {
  const [accounts, setAccounts] = useState<AgyAccount[] | null>(null);
  const [quota, setQuota] = useState<AgyQuotaView | null>(null);
  const [qBusy, setQBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [alias, setAlias] = useState("");
  const [err, setErr] = useState<{ word: string; detail: string } | null>(null);
  // 늦게 온 응답이 새 응답을 덮지 않게(계정을 연달아 바꾸거나 새로고침을 겹쳐 누를 때).
  const qSeq = useRef(0);
  const aSeq = useRef(0);

  const loadAccounts = useCallback(async () => {
    const seq = ++aSeq.current;
    try {
      const r = await window.paperAPI.agyAccounts();
      if (seq === aSeq.current) setAccounts(r);
    } catch {
      /* 이전 목록 유지 */
    }
  }, []);

  const loadQuota = useCallback(async (refresh: boolean) => {
    const seq = ++qSeq.current;
    setQBusy(true);
    try {
      const q = await window.paperAPI.agyQuotaView(refresh);
      if (seq === qSeq.current) setQuota(q);
    } catch {
      if (seq === qSeq.current) setQuota({ status: "error", at: Date.now() });
    } finally {
      if (seq === qSeq.current) setQBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
    // 캐시값 먼저 — 캐시가 없을 때만 main 이 /usage 를 1회 부른다(키체인 프롬프트는 사용자가 누를 때만 강제).
    void loadQuota(false);
    // 터미널에서 로그인하고 돌아오면 계정 표시(이메일·로그인 여부)를 바로 맞춘다. 파일 확인이라 싸다.
    const onFocus = () => void loadAccounts();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      qSeq.current++;
      aSeq.current++;
    };
  }, [loadAccounts, loadQuota]);

  const current = accounts?.find((a) => a.current) ?? null;
  const needLogin =
    !!current && !switching && (current.loggedIn === false || (!qBusy && quota?.status === "auth"));

  const switchTo = async (v: string) => {
    if (v === ADD) {
      setAdding(true);
      setAlias("");
      setErr(null);
      return;
    }
    if (!v || v === current?.alias) return;
    setErr(null);
    setSwitching(true);
    // 목록을 다시 읽는 동안 select 가 옛 값으로 튀지 않게 먼저 옮겨 둔다. 실패하면 재조회가 되돌린다.
    setAccounts((l) => l?.map((a) => ({ ...a, current: a.alias === v })) ?? l);
    try {
      const r = await window.paperAPI.agySetAccount(v);
      if (!r.ok) setErr({ word: "전환 실패", detail: r.error ?? "" });
    } catch (e) {
      setErr({ word: "전환 실패", detail: errMsg(e) });
    }
    await loadAccounts();
    setSwitching(false);
    void loadQuota(false);
    onChanged();
  };

  const login = async (a: string) => {
    setErr(null);
    try {
      const r = await window.paperAPI.agyLogin(a);
      if (!r.ok) return setErr({ word: "로그인 실패", detail: r.error ?? "" });
      setAdding(false);
      setAlias("");
    } catch (e) {
      setErr({ word: "로그인 실패", detail: errMsg(e) });
    } finally {
      // 새 별칭이면 main 이 폴더를 만들었으니 목록에 (로그인 필요로) 나타난다.
      void loadAccounts();
    }
  };

  const draft = alias.trim();
  const draftOk = ALIAS_RE.test(draft);
  const word = quota && !qBusy ? quotaWord(quota.status) : null;
  const showBars = !quota || !!(quota.h5 || quota.weekly) || quota.status === "ok" || quota.status === "unknown";
  const checkedAt = quota?.at
    ? `조회 ${new Date(quota.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`
    : "";

  return (
    <>
      <div className="typo-section">
        <span className="ctrl-label">
          계정
          {err && <em className="ai-warn" title={err.detail || undefined}>{err.word}</em>}
        </span>
        <div className="ai-row">
          <select
            value={accounts ? current?.alias ?? "" : ""}
            disabled={!accounts || switching}
            onChange={(e) => void switchTo(e.target.value)}
          >
            {!accounts && <option value="">—</option>}
            {accounts && !current && <option value="">—</option>}
            {accounts?.map((a) => (
              <option key={a.alias} value={a.alias}>
                {a.alias}
                {a.email && a.email !== "-" ? ` · ${a.email}` : ""}
                {a.loggedIn === false ? " · 로그인 필요" : ""}
              </option>
            ))}
            {accounts && <option value={ADD}>＋ 계정 추가</option>}
          </select>
          {needLogin && !adding && (
            <button className="seg-btn" title="터미널에서 로그인" onClick={() => void login(current!.alias)}>
              로그인
            </button>
          )}
        </div>
        {adding && (
          <div className="ai-row">
            <input
              type="text"
              autoFocus
              spellCheck={false}
              maxLength={20}
              placeholder="별칭"
              title="영문·숫자·_- 20자 이내"
              className={draft && !draftOk ? "ai-bad" : undefined}
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter" && draftOk) void login(draft);
                if (e.key === "Escape") {
                  e.stopPropagation(); // 설정 모달까지 닫히지 않게
                  setAdding(false);
                }
              }}
            />
            <button className="seg-btn" disabled={!draftOk} title="터미널에서 로그인" onClick={() => void login(draft)}>
              확인
            </button>
            <button className="seg-btn ai-icon-btn" title="취소" aria-label="취소" onClick={() => setAdding(false)}>
              <svg {...ICO}><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        )}
      </div>

      <div className="typo-section">
        <span className="ctrl-label">
          <span title={["갈피 밖 사용량 포함", checkedAt].filter(Boolean).join(" · ")}>한도</span>
          <span className="ai-head-right">
            {word && <em className="ai-warn">{word}</em>}
            <button
              className="ai-mini-btn"
              title="새로고침 · 키체인 창이 뜨면 '항상 허용'"
              aria-label="한도 새로고침"
              disabled={qBusy}
              onClick={() => {
                void loadQuota(true).then(onChanged);
              }}
            >
              <RefreshIcon spin={qBusy} />
            </button>
          </span>
        </span>
        {showBars && (
          <div className={`q-bars ${qBusy ? "dim" : ""}`}>
            <QuotaBar label="5시간" b={quota?.h5} />
            <QuotaBar label="주간" b={quota?.weekly} />
          </div>
        )}
      </div>
    </>
  );
}

function QuotaBar({ label, b }: { label: string; b?: { remaining: number; reset?: string } }) {
  const pct = b && Number.isFinite(b.remaining) ? Math.round(Math.min(1, Math.max(0, b.remaining)) * 100) : null;
  return (
    <div className={`q-row ${pct !== null && pct < 15 ? "low" : ""}`} title={fmtReset(b?.reset)}>
      <span className="q-label">{label}</span>
      <span className="q-track"><i style={{ width: `${pct ?? 0}%` }} /></span>
      <b className="q-pct">{pct === null ? "—" : `${pct}%`}</b>
    </div>
  );
}

// ── 사용량 ───────────────────────────────────────────────────────────
function UsageSection() {
  const [u, setU] = useState<Usage | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      window.paperAPI
        .usageSummary()
        .then((r) => alive && setU(r))
        .catch(() => { /* 이전 값 유지 */ });
    void load();
    // 문서 번역은 배치마다 usage:changed 가 온다 — 몰아서 한 번만 다시 읽는다.
    const off = window.paperAPI.onUsageChanged(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 600);
    });
    return () => {
      alive = false;
      off();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const groups = u ? groupUsage(u.byFeature) : null;

  return (
    <div className="typo-section">
      <span className="ctrl-label">사용량</span>
      <div className="u-grid">
        <UsageRow label="오늘" a={u?.today} />
        <UsageRow label="전체" a={u?.total} />
      </div>
      <div className="u-grid sub" title="전체 기준">
        {USAGE_GROUPS.map((g) => (
          <UsageRow key={g.key} label={g.label} a={groups?.[g.key]} />
        ))}
      </div>
    </div>
  );
}

function UsageRow({ label, a }: { label: string; a?: Pick<Agg, "calls" | "fail" | "in" | "out" | "think" | "usd"> }) {
  const tip = a
    ? [
        `입력 ${a.in.toLocaleString()} · 출력 ${(a.out + a.think).toLocaleString()}`,
        a.fail ? `실패 ${a.fail}` : "",
        a.usd > 0 ? `$${a.usd.toFixed(a.usd < 1 ? 3 : 2)}` : "",
      ].filter(Boolean).join(" · ")
    : undefined;
  return (
    <div className="u-row" title={tip}>
      <span className="u-label">{label}</span>
      <span className="u-tok">{a ? fmtTokens(totalTokens(a)) : "—"}</span>
      <span className="u-calls">{a ? `${a.calls.toLocaleString()}회` : ""}</span>
    </div>
  );
}

// ── 채팅 모델 ────────────────────────────────────────────────────────
function ChatModelSection() {
  const [list, setList] = useState<ChatModelList | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  // 목록 조회 중에 사용자가 고른 값 — 늦게 온 목록의 default(옛 설정값)가 방금 고른 것을 덮지 않게.
  const picked = useRef<string | null>(null);
  const pickSeq = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const s = ++seq.current;
    setBusy(true);
    try {
      const r = await window.paperAPI.chatModels(refresh);
      if (s === seq.current) {
        setList(picked.current ? { ...r, default: picked.current } : r);
        setFailed(false);
      }
    } catch {
      if (s === seq.current) setFailed(true);
    } finally {
      if (s === seq.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    return () => { seq.current++; pickSeq.current++; };
  }, [load]);

  const pick = async (id: string) => {
    const prev = list?.default;
    const s = ++pickSeq.current;
    picked.current = id;
    setList((l) => (l ? { ...l, default: id } : l));
    let ok = false;
    try {
      ok = await window.paperAPI.setChatModel(id);
    } catch {
      ok = false;
    }
    if (s !== pickSeq.current) return; // 그 사이 다른 모델을 또 골랐다
    if (ok) return;
    picked.current = null;
    if (prev !== undefined) setList((l) => (l ? { ...l, default: prev } : l));
  };

  const cur = list?.default ?? "";
  const agyModels = list?.models.filter((m) => m.group === "agy") ?? [];
  const restModels = list?.models.filter((m) => m.group !== "agy") ?? [];

  return (
    <div className="typo-section">
      <span className="ctrl-label">
        채팅 모델
        {failed && !list && <em className="ai-warn">조회 실패</em>}
      </span>
      <div className="ai-row">
        <select value={cur} disabled={!list} onChange={(e) => void pick(e.target.value)}>
          {!list && <option value="">—</option>}
          {list && cur && !list.models.some((m) => m.id === cur) && <option value={cur}>{cur}</option>}
          {agyModels.length > 0 && (
            <optgroup label="agy">
              {agyModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </optgroup>
          )}
          {restModels.length > 0 && (
            <optgroup label="API">
              {restModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </optgroup>
          )}
        </select>
        <button
          className="seg-btn ai-icon-btn"
          title="모델 목록 새로고침"
          aria-label="모델 목록 새로고침"
          disabled={busy}
          onClick={() => void load(true)}
        >
          <RefreshIcon spin={busy} />
        </button>
      </div>
    </div>
  );
}

// ── 추가 시 자동 처리 ─────────────────────────────────────────────────
function AutoSection() {
  const [auto, setAuto] = useState<{ translate: boolean; summary: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    window.paperAPI
      .aiAuto()
      .then((r) => alive && setAuto(r))
      .catch(() => { /* 토글 비활성으로 남긴다 */ });
    return () => { alive = false; };
  }, []);

  const flip = async (k: "translate" | "summary") => {
    if (!auto) return;
    const v = !auto[k];
    setAuto((a) => (a ? { ...a, [k]: v } : a));
    try {
      const r = await window.paperAPI.aiAuto({ [k]: v });
      // 다른 키를 동시에 누른 경우 그 낙관 값이 옛 응답에 덮이지 않게 이 키만 확정한다.
      setAuto((a) => (a ? { ...a, [k]: r[k] } : a));
    } catch {
      setAuto((a) => (a ? { ...a, [k]: !v } : a));
    }
  };

  return (
    <div className="typo-section">
      <span className="ctrl-label" title="PDF 추가 후">자동</span>
      <div className="ai-row">
        {(["translate", "summary"] as const).map((k) => (
          <button
            key={k}
            className={`seg-btn ai-toggle ${auto?.[k] ? "on" : ""}`}
            aria-pressed={!!auto?.[k]}
            disabled={!auto}
            title={k === "translate" ? "PDF 추가 후 전체 번역" : "번역 후 핵심 요약"}
            onClick={() => void flip(k)}
          >
            {k === "translate" ? "번역" : "요약"}
          </button>
        ))}
      </div>
    </div>
  );
}
