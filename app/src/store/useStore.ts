// 앱 상태 + 영속화 (명세 §10). Zustand.
// 설정은 "전역 단일" — 한 번 설정하면 모든 문서·메인 화면에 적용되고,
// 변경 즉시 settings.json 에 자동 저장, 앱 시작 시 자동 로드.
import { create } from "zustand";
import { DEFAULT_TYPOGRAPHY, type Typography } from "./typography";
import { DEFAULT_KEYMAP, type ActionId, type Keymap } from "../keys/keymap";
import { encodePreset, sanitizeTypography, type SavedPreset } from "../presets/share";
import type { ReadingOpts } from "../render/reading";
import type { UserFont } from "../../electron/preload";

const DEFAULT_READING: ReadingOpts = { bionic: false, sentenceBreak: false };

export interface TranslationConfig {
  apiKey: string;
  model: string;
}

interface GlobalSettings {
  typography: Typography;
  fonts: UserFont[];
  translation?: TranslationConfig;
  keymap?: Partial<Keymap>;
  customPresets?: SavedPreset[];
  reading?: Partial<ReadingOpts>;
}

const DEFAULT_TRANSLATION: TranslationConfig = { apiKey: "", model: "gemini-2.0-flash" };

let presetSeq = 0;
function newPresetId(): string {
  return "p_" + Date.now().toString(36) + (presetSeq++).toString(36);
}

interface Store {
  typography: Typography;
  userFonts: UserFont[];
  translation: TranslationConfig;
  keymap: Keymap;
  customPresets: SavedPreset[];
  reading: ReadingOpts;
  loaded: boolean;

  initSession: () => Promise<void>;
  setReading: (patch: Partial<ReadingOpts>) => void;
  setTypography: (patch: Partial<Typography>) => void;
  resetToDefault: () => void;
  addUserFonts: () => Promise<void>;
  setTranslationConfig: (patch: Partial<TranslationConfig>) => Promise<void>;

  setKeybinding: (id: ActionId, combo: string) => void;
  resetKeymap: () => void;

  saveCurrentAsPreset: (name: string) => void;
  applyPreset: (typography: Typography) => void;
  deletePreset: (id: string) => void;
  // 디코드된 프리셋을 목록에 추가(+ 즉시 적용). 공유 코드는 presets/share 에서 디코드.
  importPreset: (name: string, typography: Typography) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useStore = create<Store>((set, get) => ({
  typography: DEFAULT_TYPOGRAPHY,
  userFonts: [],
  translation: DEFAULT_TRANSLATION,
  keymap: DEFAULT_KEYMAP,
  customPresets: [],
  reading: DEFAULT_READING,
  loaded: false,

  // 앱 시작 시 전역 설정 로드 (타이포 + 사용자 폰트 + 번역 + 단축키 + 사용자 프리셋)
  initSession: async () => {
    const g = (await window.paperAPI.loadSettings()) as GlobalSettings | null;
    set({
      typography: { ...DEFAULT_TYPOGRAPHY, ...(g?.typography ?? {}) },
      userFonts: g?.fonts ?? [],
      translation: { ...DEFAULT_TRANSLATION, ...(g?.translation ?? {}) },
      keymap: { ...DEFAULT_KEYMAP, ...(g?.keymap ?? {}) },
      customPresets: Array.isArray(g?.customPresets)
        ? g!.customPresets!.map((p) => ({ ...p, typography: sanitizeTypography(p.typography) }))
        : [],
      reading: { ...DEFAULT_READING, ...(g?.reading ?? {}) },
      loaded: true,
    });
  },

  setReading: (patch) => {
    set((st) => ({ reading: { ...st.reading, ...patch } }));
    void persistSettings(get);
  },

  // 실시간 조정 → 즉시 반영 + 디바운스 자동저장(전역)
  setTypography: (patch) => {
    set((st) => ({ typography: { ...st.typography, ...patch } }));
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void persistSettings(get), 300);
  },

  resetToDefault: () => {
    set({ typography: { ...DEFAULT_TYPOGRAPHY } });
    void persistSettings(get);
  },

  // 로컬 폰트 파일 추가 (§6.3) → @font-face 동적 등록 + 전역 보관
  addUserFonts: async () => {
    const picked = await window.paperAPI.pickFonts();
    if (!picked.length) return;
    const merged = dedupeFonts([...get().userFonts, ...picked]);
    set({ userFonts: merged });
    registerFonts(picked);
    await persistSettings(get);
  },

  // 번역 설정(API 키/모델) 갱신 + 즉시 저장
  setTranslationConfig: async (patch) => {
    set({ translation: { ...get().translation, ...patch } });
    await persistSettings(get);
  },

  // ── 단축키 ──────────────────────────────────────────────────────
  setKeybinding: (id, combo) => {
    set((st) => ({ keymap: { ...st.keymap, [id]: combo } }));
    void persistSettings(get);
  },
  resetKeymap: () => {
    set({ keymap: { ...DEFAULT_KEYMAP } });
    void persistSettings(get);
  },

  // ── 사용자 프리셋 (저장 · 공유 · 불러오기) ────────────────────────
  saveCurrentAsPreset: (name) => {
    const preset: SavedPreset = {
      id: newPresetId(),
      name: name.trim().slice(0, 80) || "내 프리셋",
      typography: { ...get().typography },
    };
    set((st) => ({ customPresets: [...st.customPresets, preset] }));
    void persistSettings(get);
  },
  applyPreset: (typography) => {
    get().setTypography(sanitizeTypography(typography));
  },
  deletePreset: (id) => {
    set((st) => ({ customPresets: st.customPresets.filter((p) => p.id !== id) }));
    void persistSettings(get);
  },
  importPreset: (name, typography) => {
    const preset: SavedPreset = {
      id: newPresetId(),
      name: name.trim().slice(0, 80) || "공유 프리셋",
      typography: sanitizeTypography(typography),
    };
    set((st) => ({ customPresets: [...st.customPresets, preset] }));
    get().setTypography(preset.typography);
    void persistSettings(get);
  },
}));

// 프리셋 → 공유 코드(타이포만). UI 에서 클립보드 복사에 사용.
export function presetShareCode(preset: SavedPreset): string {
  return encodePreset(preset.name, preset.typography);
}

// 전역 settings.json 을 한 곳에서 직렬화 — 부분 저장이 다른 키를 덮어쓰지 않게.
async function persistSettings(get: () => Store): Promise<void> {
  const { typography, userFonts, translation, keymap, customPresets, reading } = get();
  await window.paperAPI.saveSettings({ typography, fonts: userFonts, translation, keymap, customPresets, reading });
}

function dedupeFonts(fonts: UserFont[]): UserFont[] {
  const seen = new Set<string>();
  return fonts.filter((f) => (seen.has(f.name) ? false : (seen.add(f.name), true)));
}

// @font-face 동적 등록: family 이름 = 파일명(확장자 제거)
export function fontFamilyName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

export function registerFonts(fonts: UserFont[]): void {
  for (const f of fonts) {
    const family = fontFamilyName(f.name);
    const css = `@font-face{font-family:"${family}";src:url(${f.dataUrl});font-display:swap;}`;
    const style = document.createElement("style");
    style.dataset.userFont = family;
    style.textContent = css;
    document.head.appendChild(style);
  }
}
