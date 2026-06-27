// 읽기 설정 패널 (§6.2, §6.3). 모든 값 실시간 → CSS 변수. 넓은 모달.
// 입력은 슬라이더 + 증감(−/＋) 버튼 조합(드래그·미세조정 둘 다 편하게).
import { useState, useEffect, useRef } from "react";
import { useStore, fontFamilyName, presetShareCode } from "../store/useStore";
import { decodePreset, type SavedPreset } from "../presets/share";
import { AISettings } from "../ai/AISettings";
import {
  FONT_OPTIONS,
  PRESETS,
  type AlignKey,
  type ThemeKey,
  type Typography,
} from "../store/typography";

// step 격자에 맞춰 부동소수 오차 제거
function snap(v: number, step: number): number {
  return parseFloat((Math.round(v / step) * step).toFixed(4));
}

function Control(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  display?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const { value, min, max, step } = props;
  const set = (v: number) => props.onChange(Math.min(max, Math.max(min, snap(v, step))));
  return (
    <div className="set-ctrl">
      <div className="set-ctrl-top">
        <span>{props.label}</span>
        <em>{props.display ? props.display(value) : value}{props.suffix}</em>
      </div>
      <div className="set-ctrl-row">
        <button className="step-btn" onClick={() => set(value - step)} disabled={value <= min} aria-label="줄이기">−</button>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => props.onChange(parseFloat(e.target.value))}
        />
        <button className="step-btn" onClick={() => set(value + step)} disabled={value >= max} aria-label="늘리기">＋</button>
      </div>
    </div>
  );
}

interface MetricDef {
  key: keyof Typography;
  label: string;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  display?: (v: number) => string;
}

const METRICS: MetricDef[] = [
  { key: "fontSize", label: "글자 크기", min: 14, max: 24, step: 1, suffix: "px" },
  { key: "lineHeight", label: "줄간격", min: 1.3, max: 2.4, step: 0.05, display: (v) => v.toFixed(2) },
  { key: "paragraphSpacing", label: "문단 간격", min: 0.4, max: 2.0, step: 0.1, suffix: "em", display: (v) => v.toFixed(1) },
  { key: "contentMaxWidth", label: "본문 폭", min: 560, max: 960, step: 20, suffix: "px" },
  { key: "letterSpacing", label: "자간", min: -0.02, max: 0.08, step: 0.005, suffix: "em", display: (v) => v.toFixed(3) },
  { key: "mathScale", label: "수식 크기", min: 0.9, max: 1.3, step: 0.05, display: (v) => v.toFixed(2) + "×" },
];

export function TypographyPanel({
  onClose,
  onOpenShortcuts,
}: {
  onClose: () => void;
  onOpenShortcuts: () => void;
}) {
  const t = useStore((s) => s.typography);
  const userFonts = useStore((s) => s.userFonts);
  const set = useStore((s) => s.setTypography);
  const reading = useStore((s) => s.reading);
  const setReading = useStore((s) => s.setReading);
  const customPresets = useStore((s) => s.customPresets);
  const saveCurrentAsPreset = useStore((s) => s.saveCurrentAsPreset);
  const applyPreset = useStore((s) => s.applyPreset);
  const deletePreset = useStore((s) => s.deletePreset);
  const importPreset = useStore((s) => s.importPreset);
  const apply = (patch: Partial<Typography>) => set(patch);

  const [tab, setTab] = useState<"read" | "ai">("read");
  const [presetName, setPresetName] = useState("");
  const [importText, setImportText] = useState("");
  const [importErr, setImportErr] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 배포: 버전 / 추출 엔진 상태 / 업데이트 확인
  const [version, setVersion] = useState("");
  const [pipe, setPipe] = useState<{ pythonOk: boolean; scriptOk: boolean; setupScript: string } | null>(null);
  const [upd, setUpd] = useState<{ msg: string; url?: string } | null>(null);
  const refreshPipe = () => window.paperAPI.pipelineStatus().then(setPipe);
  useEffect(() => {
    window.paperAPI.appVersion().then(setVersion);
    refreshPipe();
  }, []);
  const onCheckUpdate = async () => {
    setUpd({ msg: "확인 중…" });
    const r = await window.paperAPI.checkUpdate();
    if (r.error) setUpd({ msg: `확인 실패: ${r.error}` });
    else if (r.hasUpdate) setUpd({ msg: `새 버전 v${r.latest} 가 있습니다.`, url: r.url });
    else setUpd({ msg: `최신 버전입니다 (v${r.current}).` });
  };
  const onPickPython = async () => {
    const r = await window.paperAPI.pickPython();
    if (!r.canceled) refreshPipe();
  };
  const engineReady = !!pipe && pipe.pythonOk && pipe.scriptOk;

  // 원클릭 엔진 설치 + 진행 로그
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [installLog]);
  const onInstall = async () => {
    setInstalling(true);
    setInstallLog(["설치 시작 — Python·MinerU 자동 설치. 수 분 걸리고 용량이 큽니다…"]);
    const off = window.paperAPI.onInstallLog((line) =>
      setInstallLog((p) => [...p, ...line.split(/\r?\n/).filter(Boolean)].slice(-400)),
    );
    let res: { code: number; error?: string } = { code: -1 };
    try {
      res = await window.paperAPI.installEngine();
    } finally {
      off();
      setInstalling(false);
    }
    await refreshPipe();
    setInstallLog((p) => [
      ...p,
      res.code === 0
        ? "✓ 설치 완료! 이제 PDF를 창에 끌어다 놓으면 추출됩니다."
        : `✗ 실패(코드 ${res.code})${res.error ? " — " + res.error : ""}. 로그를 확인하세요.`,
    ]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fontChoices = [
    ...FONT_OPTIONS,
    ...userFonts.map((f) => {
      const fam = fontFamilyName(f.name);
      return { label: `${fam} (추가됨)`, value: `"${fam}"` };
    }),
  ];

  // 기본 + 사용자 프리셋을 한 줄로 통합
  const presetChips = [
    ...Object.keys(PRESETS).map((name) => ({ id: "b:" + name, name, apply: () => apply(PRESETS[name]) })),
    ...customPresets.map((p) => ({ id: p.id, name: p.name, apply: () => applyPreset(p.typography) })),
  ];

  const onSavePreset = () => {
    saveCurrentAsPreset(presetName);
    setPresetName("");
  };
  const onShare = async (p: SavedPreset) => {
    try {
      await navigator.clipboard.writeText(presetShareCode(p));
      setCopiedId(p.id);
      setTimeout(() => setCopiedId((c) => (c === p.id ? null : c)), 1600);
    } catch {
      setCopiedId(null);
    }
  };
  const onImport = () => {
    const decoded = decodePreset(importText);
    if (!decoded) return setImportErr(true);
    importPreset(decoded.name, decoded.typography);
    setImportText("");
    setImportErr(false);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <aside className="typo-panel modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="typo-head">
          <strong>설정</strong>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">×</button>
        </div>

        <div className="seg tabs">
          <button className={`seg-btn ${tab === "read" ? "on" : ""}`} onClick={() => setTab("read")}>읽기</button>
          <button className={`seg-btn ${tab === "ai" ? "on" : ""}`} onClick={() => setTab("ai")}>AI</button>
        </div>

        {tab === "ai" && <AISettings />}

        {tab === "read" && (
        <>
        {/* 테마 · 정렬 */}
        <div className="typo-section">
          <div className="seg">
            {(["light", "sepia", "dark"] as ThemeKey[]).map((th) => (
              <button key={th} className={`seg-btn ${t.theme === th ? "on" : ""}`} onClick={() => apply({ theme: th })}>
                {th === "light" ? "라이트" : th === "sepia" ? "세피아" : "다크"}
              </button>
            ))}
          </div>
          <div className="seg">
            {(["left", "justify"] as AlignKey[]).map((al) => (
              <button key={al} className={`seg-btn ${t.textAlign === al ? "on" : ""}`} onClick={() => apply({ textAlign: al })}>
                {al === "left" ? "왼쪽 정렬" : "양쪽 정렬"}
              </button>
            ))}
          </div>
        </div>

        {/* 글꼴 */}
        <div className="typo-section">
          <div className="set-grid">
            <label className="ctrl">
              <span className="ctrl-label">본문 글꼴</span>
              <select value={t.fontFamily} onChange={(e) => apply({ fontFamily: e.target.value })}>
                {fontChoices.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </label>
            <label className="ctrl">
              <span className="ctrl-label">제목 글꼴</span>
              <select value={t.headingFontFamily} onChange={(e) => apply({ headingFontFamily: e.target.value })}>
                {fontChoices.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </label>
          </div>
          <div className="font-row">
            <div className="font-preview" style={{ fontFamily: t.fontFamily }}>
              The quick brown fox · 가독성 미리보기 · αβγ ∑∫
            </div>
            <button className="link-btn" onClick={() => useStore.getState().addUserFonts()}>+ 폰트 추가</button>
          </div>
        </div>

        {/* 본문 — 슬라이더 + 증감 버튼 */}
        <div className="typo-section">
          <div className="set-grid">
            {METRICS.map((m) => (
              <Control
                key={m.key}
                label={m.label}
                value={t[m.key] as number}
                min={m.min}
                max={m.max}
                step={m.step}
                suffix={m.suffix}
                display={m.display}
                onChange={(v) => apply({ [m.key]: v } as Partial<Typography>)}
              />
            ))}
          </div>
        </div>

        {/* 프리셋 (기본 + 내 것 통합) */}
        <div className="typo-section">
          <span className="ctrl-label">프리셋</span>
          <div className="preset-chips">
            {presetChips.map((p) => (
              <button key={p.id} className="seg-btn" onClick={p.apply}>{p.name}</button>
            ))}
          </div>
          <div className="set-save">
            <input
              type="text"
              placeholder="현재 설정을 프리셋으로 저장"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onSavePreset()}
            />
            <button className="seg-btn" onClick={onSavePreset}>저장</button>
          </div>

          <details className="set-advanced">
            <summary>공유 · 코드로 불러오기</summary>
            <div className="set-advanced-body">
              <div className="set-import">
                <input
                  type="text"
                  placeholder="galpi-preset-v1:… 붙여넣기"
                  value={importText}
                  onChange={(e) => { setImportText(e.target.value); setImportErr(false); }}
                  onKeyDown={(e) => e.key === "Enter" && onImport()}
                />
                <button className="seg-btn" onClick={onImport}>불러오기</button>
              </div>
              {importErr && <p className="typo-note" style={{ color: "var(--accent)" }}>코드를 인식할 수 없습니다.</p>}
              {customPresets.length > 0 && (
                <ul className="set-preset-manage">
                  {customPresets.map((p) => (
                    <li key={p.id}>
                      <span className="set-preset-name">{p.name}</span>
                      <button className="set-mini" onClick={() => onShare(p)}>{copiedId === p.id ? "복사됨 ✓" : "공유"}</button>
                      <button className="set-mini" onClick={() => deletePreset(p.id)} aria-label="삭제">🗑</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        </div>

        {/* 읽기 보조 */}
        <div className="typo-section">
          <span className="ctrl-label">읽기 보조 <span className="muted-inline">(단축키 B · L)</span></span>
          <div className="seg">
            <button
              className={`seg-btn ${reading.bionic ? "on" : ""}`}
              onClick={() => setReading({ bionic: !reading.bionic })}
            >
              Bionic Reading
            </button>
            <button
              className={`seg-btn ${reading.sentenceBreak ? "on" : ""}`}
              onClick={() => setReading({ sentenceBreak: !reading.sentenceBreak })}
            >
              문장 줄바꿈
            </button>
          </div>
          <p className="typo-note">Bionic=단어 앞부분 굵게, 문장 줄바꿈=문장 끝마다 줄바꿈(진짜 문장만).</p>
        </div>

        {/* 단축키 */}
        <div className="typo-section">
          <button className="seg-btn full" onClick={onOpenShortcuts}>단축키 설정…</button>
        </div>

        {/* 번역/AI 키·모델은 상단 'AI' 탭으로 이동 */}

        {/* 추출 엔진 · 업데이트 (배포) */}
        <div className="typo-section">
          <div className="dist-row">
            <span className="ctrl-label">버전 {version && `v${version}`}</span>
            <button className="seg-btn" onClick={onCheckUpdate}>업데이트 확인</button>
          </div>
          {upd && (
            <p className="typo-note">
              {upd.msg}{" "}
              {upd.url && (
                <button className="link-btn" style={{ display: "inline" }} onClick={() => window.paperAPI.openExternal(upd.url!)}>
                  다운로드 페이지 열기 ↗
                </button>
              )}
            </p>
          )}
          <div className="dist-row">
            <span className="ctrl-label">추출 엔진 {pipe ? (engineReady ? "✓ 준비됨" : "⚠ 미설치") : "…"}</span>
            <button className="seg-btn" onClick={onPickPython}>Python 직접 지정</button>
          </div>
          {pipe && !engineReady && (
            <>
              <button className="seg-btn full" onClick={onInstall} disabled={installing}>
                {installing ? "설치 중… (창을 닫지 마세요)" : "⬇ 추출 엔진 설치 (원클릭)"}
              </button>
              <p className="typo-note">
                PDF를 직접 추출하려면 한 번 설치가 필요합니다. 버튼을 누르면 Python·MinerU 를 자동
                설치합니다(수 분·용량 큼). Homebrew 가 없으면 로그에 안내가 표시됩니다.
              </p>
            </>
          )}
          {installLog.length > 0 && (
            <pre ref={logRef} className="install-log">{installLog.join("\n")}</pre>
          )}
        </div>

        <div className="typo-section typo-actions">
          <button className="link-btn" onClick={() => useStore.getState().resetToDefault()}>기본값으로 되돌리기</button>
          <span className="typo-note">설정은 자동 저장됩니다.</span>
        </div>
        </>
        )}
      </aside>
    </div>
  );
}
