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
    // --page-padding 은 styles.css 의 고정값(본문 폭으로 일원화) 사용 — 여기서 내보내지 않음.
  };
}
