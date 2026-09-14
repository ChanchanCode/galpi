// 타이포그래피 설정 모델 + CSS 변수 매핑 + 프리셋 (명세 §6.2, §6.3).

export type ThemeKey = "light" | "sepia" | "dark";
export type AlignKey = "left" | "justify";

export interface Typography {
  contentMaxWidth: number; // px  (560–960) — 본문 폭(여백은 이 폭 안에서 일정하게 유지)
  lineHeight: number; //          (1.3–2.4)
  paragraphSpacing: number; // em (0.4–2.0)
  fontSize: number; // px         (14–24)
  letterSpacing: number; // em    (-0.02–0.08)
  fontFamily: string;
  headingFontFamily: string;
  mathScale: number; //           (0.9–1.3)
  textAlign: AlignKey;
  theme: ThemeKey;

  // ── 번역 컬럼 축 (PLAN-AI §7.5, D15) ──────────────────────────────
  // **글꼴만 연동이 기본**, 크기·줄간격·자간은 독립이다.
  // 영문 세리프 16.5px 과 한글 15.5px 은 같은 크기가 아니고, 한글은 줄간격이 더 넓어야 한다.
  trFontLinked: boolean; //       글꼴을 원문과 함께 바꿀지
  trFontFamily: string; //        연동 해제 시 쓰는 번역 전용 글꼴
  // 크기·줄간격은 **보기별로 따로**다. 정리 모드는 원문 옆에 서고, 원본 모드는 지면 옆에 선다 —
  // 같은 값이 두 자리에서 다 맞을 수가 없다.
  trReflowLinked: boolean; //     정리 모드: 원문 값을 그대로 따라갈지(기본)
  trReflowFontSize: number; // px (8–28)
  trReflowLineHeight: number; //  (1.3–2.6)
  trFontSize: number; // px       원본 모드 (8–22)
  trLineHeight: number; //        원본 모드 (1.3–2.6)
  trLetterSpacing: number; // em  (-0.04–0.10) — 두 보기 공통
}

// 내장 폰트 스택 (§6.3). 시스템 가용 폰트 위주 + 사용자 업로드로 확장.
// OpenDyslexic 등은 "폰트 추가"(fonts:pick)로 등록해 family 이름으로 선택.
export const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: "세리프 (Iowan/Palatino)", value: '"Iowan Old Style", Palatino, Georgia, serif' },
  { label: "세리프 (Georgia)", value: "Georgia, 'Times New Roman', serif" },
  { label: "산세리프 (시스템)", value: "-apple-system, 'Helvetica Neue', Arial, sans-serif" },
  { label: "산세리프 (Avenir)", value: '"Avenir Next", Avenir, sans-serif' },
  { label: "모노 (가독)", value: "ui-monospace, 'SF Mono', Menlo, monospace" },
];

export const DEFAULT_TYPOGRAPHY: Typography = {
  contentMaxWidth: 720,
  lineHeight: 1.7,
  paragraphSpacing: 1.0,
  fontSize: 18,
  letterSpacing: 0,
  fontFamily: FONT_OPTIONS[0].value,
  headingFontFamily: FONT_OPTIONS[0].value,
  mathScale: 1.0,
  textAlign: "left",
  theme: "light",
  trFontLinked: true,
  trFontFamily: FONT_OPTIONS[2].value,
  trReflowLinked: true,
  trReflowFontSize: 18,
  trReflowLineHeight: 1.7,
  // 사용자가 직접 맞춘 값(2026-08-26). 좁은 컬럼의 한글은 줄간격이 넉넉해야 읽힌다.
  trFontSize: 14,
  trLineHeight: 2.3,
  trLetterSpacing: 0,
};

// 프리셋 (§6.2): 기본 / 집중(사용자 공유 설정) / 고대비
export const PRESETS: Record<string, Partial<Typography>> = {
  기본: { ...DEFAULT_TYPOGRAPHY },
  집중: {
    contentMaxWidth: 860,
    lineHeight: 2.25,
    paragraphSpacing: 1.8,
    fontSize: 20,
    letterSpacing: 0,
    fontFamily: FONT_OPTIONS[0].value,
    headingFontFamily: FONT_OPTIONS[0].value,
    mathScale: 1.0,
    textAlign: "left",
    theme: "sepia",
  },
  고대비: { theme: "dark", fontSize: 20, lineHeight: 1.8, letterSpacing: 0.01 },
};

/** Typography → CSS 변수 객체 (reader 루트에 적용). styles.css 의 var 이름과 일치. */
export function toCssVars(t: Typography): Record<string, string> {
  return {
    "--content-max-width": `${t.contentMaxWidth}px`,
    "--line-height": `${t.lineHeight}`,
    "--paragraph-spacing": `${t.paragraphSpacing}em`,
    "--font-size": `${t.fontSize}px`,
    "--letter-spacing": `${t.letterSpacing}em`,
    "--font-family": t.fontFamily,
    "--heading-font-family": t.headingFontFamily,
    "--math-scale": `${t.mathScale}`,
    "--text-align": t.textAlign,
    // 번역 컬럼 — 글꼴만 연동(D15), 나머지는 독립 축.
    "--tr-font-family": t.trFontLinked ? t.fontFamily : t.trFontFamily,
    // 정리 모드(보기 A) — 연동이면 원문 값을 그대로 쓴다.
    "--tr-reflow-font-size": t.trReflowLinked ? `${t.fontSize}px` : `${t.trReflowFontSize}px`,
    "--tr-reflow-line-height": t.trReflowLinked ? `${t.lineHeight}` : `${t.trReflowLineHeight}`,
    // 원본 모드(보기 B)
    "--tr-font-size": `${t.trFontSize}px`,
    "--tr-line-height": `${t.trLineHeight}`,
    "--tr-letter-spacing": `${t.trLetterSpacing}em`,
    // --page-padding 은 styles.css 의 고정값(본문 폭으로 일원화) 사용 — 여기서 내보내지 않음.
  };
}
