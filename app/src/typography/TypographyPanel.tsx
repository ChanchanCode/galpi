// 타이포그래피 설정 패널 (명세 §6.2, §6.3). 모든 값 실시간 → CSS 변수.
import { useStore, fontFamilyName } from "../store/useStore";
import {
  FONT_OPTIONS,
  PRESETS,
  type AlignKey,
  type ThemeKey,
  type Typography,
} from "../store/typography";

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="ctrl">
      <span className="ctrl-label">
        {props.label}
        <em>{props.value}{props.suffix}</em>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
      />
    </label>
  );
}

export function TypographyPanel({ onClose }: { onClose: () => void }) {
  const t = useStore((s) => s.typography);
  const userFonts = useStore((s) => s.userFonts);
  const set = useStore((s) => s.setTypography);
  const apply = (patch: Partial<Typography>) => set(patch);

  const fontChoices = [
    ...FONT_OPTIONS,
    ...userFonts.map((f) => {
      const fam = fontFamilyName(f.name);
      return { label: `${fam} (추가됨)`, value: `"${fam}"` };
    }),
  ];

  return (
    <aside className="typo-panel">
      <div className="typo-head">
        <strong>읽기 설정</strong>
        <button className="icon-btn" onClick={onClose} aria-label="닫기">×</button>
      </div>

      <div className="typo-section">
        <div className="seg">
          {(["light", "sepia", "dark"] as ThemeKey[]).map((th) => (
            <button
              key={th}
              className={`seg-btn ${t.theme === th ? "on" : ""}`}
              onClick={() => apply({ theme: th })}
            >
              {th === "light" ? "라이트" : th === "sepia" ? "세피아" : "다크"}
            </button>
          ))}
        </div>
        <div className="seg">
          {(["left", "justify"] as AlignKey[]).map((al) => (
            <button
              key={al}
              className={`seg-btn ${t.textAlign === al ? "on" : ""}`}
              onClick={() => apply({ textAlign: al })}
            >
              {al === "left" ? "왼쪽 정렬" : "양쪽 정렬"}
            </button>
          ))}
        </div>
      </div>

      <div className="typo-section">
        <label className="ctrl">
          <span className="ctrl-label">본문 글꼴</span>
          <select value={t.fontFamily} onChange={(e) => apply({ fontFamily: e.target.value })}>
            {fontChoices.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </label>
        <label className="ctrl">
          <span className="ctrl-label">제목 글꼴</span>
          <select value={t.headingFontFamily} onChange={(e) => apply({ headingFontFamily: e.target.value })}>
            {fontChoices.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </label>
        <button className="link-btn" onClick={() => useStore.getState().addUserFonts()}>
          + 폰트 파일 추가 (.ttf/.otf)
        </button>
        <div className="font-preview" style={{ fontFamily: t.fontFamily }}>
          The quick brown fox · 가독성 미리보기 · αβγ ∑∫
        </div>
      </div>

      <div className="typo-section">
        <Slider label="글자 크기" value={t.fontSize} min={14} max={24} step={1} suffix="px"
          onChange={(v) => apply({ fontSize: v })} />
        <Slider label="줄간격" value={t.lineHeight} min={1.3} max={2.4} step={0.05}
          onChange={(v) => apply({ lineHeight: v })} />
        <Slider label="문단 간격" value={t.paragraphSpacing} min={0.4} max={2.0} step={0.1} suffix="em"
          onChange={(v) => apply({ paragraphSpacing: v })} />
        <Slider label="본문 폭" value={t.contentMaxWidth} min={560} max={960} step={10} suffix="px"
          onChange={(v) => apply({ contentMaxWidth: v })} />
        <Slider label="자간" value={t.letterSpacing} min={-0.02} max={0.08} step={0.005} suffix="em"
          onChange={(v) => apply({ letterSpacing: v })} />
        <Slider label="여백" value={t.pagePadding} min={16} max={96} step={4} suffix="px"
          onChange={(v) => apply({ pagePadding: v })} />
        <Slider label="수식 크기" value={t.mathScale} min={0.9} max={1.3} step={0.05}
          onChange={(v) => apply({ mathScale: v })} />
      </div>

      <div className="typo-section">
        <span className="ctrl-label">프리셋</span>
        <div className="seg">
          {Object.keys(PRESETS).map((name) => (
            <button key={name} className="seg-btn" onClick={() => apply(PRESETS[name])}>
              {name}
            </button>
          ))}
        </div>
      </div>

      <div className="typo-section typo-actions">
        <button className="link-btn" onClick={() => useStore.getState().resetToGlobalDefault()}>
          기본값으로 되돌리기
        </button>
        <button className="link-btn" onClick={() => useStore.getState().saveAsGlobalDefault()}>
          전역 기본값으로 저장
        </button>
      </div>
    </aside>
  );
}
