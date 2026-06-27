// 중앙 키맵 — 모든 기능 단축키를 한 곳에서 정의하고 사용자가 재설정할 수 있게 한다.
// 각 기능 컴포넌트는 이 모듈의 matchCombo() 로 자기 액션의 바인딩과 이벤트를 비교한다.
// 바인딩은 전역 settings.json(useStore) 에 영속되고, 단축키 설정 창에서 편집한다.

export type ActionId =
  | "search"
  | "highlight"
  | "translate"
  | "sourcePeek"
  | "sections"
  | "focus"
  | "bionic"
  | "sentenceBreak";

export interface ActionDef {
  id: ActionId;
  label: string;
  hint: string;
  defaultCombo: string;
}

// 화면에 떠다니는 UI 없이 키보드로 동작하는 액션들(사용자 요청: text 위 hover UI 금지).
export const ACTIONS: ActionDef[] = [
  { id: "search", label: "텍스트 검색", hint: "본문에서 단어 찾기 (다음 Enter · 이전 ⇧Enter)", defaultCombo: "Mod+F" },
  { id: "highlight", label: "형광펜", hint: "선택 후 탭하면 색 순환(노랑→초록→파랑→분홍→보라→해제) · 꾹 누르면 제거", defaultCombo: "H" },
  { id: "translate", label: "번역", hint: "선택 문장 번역 팝오버", defaultCombo: "T" },
  { id: "sourcePeek", label: "원문 대조", hint: "선택/현재 위치 블록의 원본 PDF 크롭 보기", defaultCombo: "G" },
  { id: "sections", label: "목차 패널", hint: "섹션 목차 패널 열기/닫기 (스크롤 옆 위치 눈금은 항상 표시)", defaultCombo: "Backslash" },
  { id: "focus", label: "포커스 모드", hint: "현재 문단만 또렷하게 (나머지 흐리게)", defaultCombo: "F" },
  { id: "bionic", label: "Bionic Reading", hint: "단어 앞부분을 굵게 — 시선 유도", defaultCombo: "B" },
  { id: "sentenceBreak", label: "문장 줄바꿈", hint: "문장 끝마다 줄바꿈(진짜 문장만)", defaultCombo: "L" },
];

export type Keymap = Record<ActionId, string>;

export const DEFAULT_KEYMAP: Keymap = ACTIONS.reduce((m, a) => {
  m[a.id] = a.defaultCombo;
  return m;
}, {} as Keymap);

export const IS_MAC =
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

// 이벤트에서 "기본 키"를 추출 — e.code 우선(Alt+문자 데드키/레이아웃 차이 회피).
// 반환 null = 수식 키 단독(아직 조합 아님).
export function baseKey(e: KeyboardEvent): string | null {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3); // KeyF → F
  if (/^Digit[0-9]$/.test(c)) return c.slice(5); // Digit1 → 1
  const named: Record<string, string> = {
    Backslash: "Backslash",
    Slash: "Slash",
    Space: "Space",
    Comma: "Comma",
    Period: "Period",
    Semicolon: "Semicolon",
    Quote: "Quote",
    BracketLeft: "BracketLeft",
    BracketRight: "BracketRight",
    Backquote: "Backquote",
    Minus: "Minus",
    Equal: "Equal",
  };
  if (named[c]) return named[c];
  const k = e.key;
  if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta") return null;
  if (/^(Arrow|F\d|Enter|Escape|Tab|Backspace|Delete|Home|End|PageUp|PageDown)/.test(k)) return k;
  return null;
}

// 이벤트 → 정규화된 combo 문자열. 수식 키 순서 고정: Mod, Alt, Shift, <key>.
// Mod = mac ⌘ / 그 외 Ctrl.
export function eventToCombo(e: KeyboardEvent): string | null {
  const key = baseKey(e);
  if (!key) return null;
  const parts: string[] = [];
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (mod) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

export function comboKey(combo: string): string {
  return combo.split("+").pop() ?? combo;
}

// 이벤트가 combo 와 일치하는지(수식 키까지 정확히).
export function matchCombo(e: KeyboardEvent, combo: string): boolean {
  return eventToCombo(e) === combo;
}

// 입력 필드에서의 단축키 차단용.
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

// combo 문자열 → 사람이 읽는 표기(⌘F / Ctrl+F / ⇧Enter …).
export function displayCombo(combo: string): string {
  if (!combo) return "—";
  const labels: Record<string, string> = {
    Mod: IS_MAC ? "⌘" : "Ctrl",
    Alt: IS_MAC ? "⌥" : "Alt",
    Shift: IS_MAC ? "⇧" : "Shift",
    Backslash: "\\",
    Slash: "/",
    Space: "Space",
    Comma: ",",
    Period: ".",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    Enter: "Enter",
    Escape: "Esc",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
  };
  const parts = combo.split("+").map((p) => labels[p] ?? p);
  // mac 은 수식 기호를 붙여 쓰고(⌘F), 그 외는 + 로 연결(Ctrl+F).
  const sep = IS_MAC ? "" : "+";
  return parts.join(sep);
}
