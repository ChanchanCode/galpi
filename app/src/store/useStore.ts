// 앱 상태 + 영속화 (명세 §10). Zustand.
// 설정은 "전역 단일" — 한 번 설정하면 모든 문서·메인 화면에 적용되고,
// 변경 즉시 settings.json 에 자동 저장, 앱 시작 시 자동 로드.
import { create } from "zustand";
import { DEFAULT_TYPOGRAPHY, type Typography } from "./typography";
import { DEFAULT_KEYMAP, type ActionId, type Keymap } from "../keys/keymap";
import { encodePreset, sanitizeTypography, type SavedPreset } from "../presets/share";
import { DEFAULT_AI, migrateAI, type AIConfig, type AIProvider } from "../ai/ai";
import type { ReadingOpts } from "../render/reading";
import type { UserFont } from "../../electron/preload";

const DEFAULT_READING: ReadingOpts = { bionic: false, sentenceBreak: false };

interface GlobalSettings {
  typography: Typography;
  fonts: UserFont[];
  translation?: { apiKey?: string; model?: string }; // 레거시(마이그레이션용)
  ai?: AIConfig;
  keymap?: Partial<Keymap>;
  customPresets?: SavedPreset[];
  reading?: Partial<ReadingOpts>;
}

let presetSeq = 0;
function newPresetId(): string {
  return "p_" + Date.now().toString(36) + (presetSeq++).toString(36);
}

interface Store {
  typography: Typography;
  userFonts: UserFont[];
  ai: AIConfig;
  keymap: Keymap;
  customPresets: SavedPreset[];
  reading: ReadingOpts;
  loaded: boolean;

  initSession: () => Promise<void>;
  setReading: (patch: Partial<ReadingOpts>) => void;
  setTypography: (patch: Partial<Typography>) => void;
  resetToDefault: () => void;
  addUserFonts: () => Promise<void>;
  setAIProvider: (provider: AIProvider) => void;
  setAIKey: (provider: AIProvider, key: string) => void;
  setAIModel: (provider: AIProvider, model: string) => void;

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
  ai: DEFAULT_AI,
  keymap: DEFAULT_KEYMAP,
  customPresets: [],
  reading: DEFAULT_READING,
  loaded: false,

  // 앱 시작 시 전역 설정 로드 (타이포 + 사용자 폰트 + AI + 단축키 + 사용자 프리셋)
  initSession: async () => {
    const g = (await window.paperAPI.loadSettings()) as GlobalSettings | null;
    set({
      typography: { ...DEFAULT_TYPOGRAPHY, ...(g?.typography ?? {}) },
      userFonts: g?.fonts ?? [],
      ai: migrateAI(g?.ai, g?.translation),
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

  // ── AI 설정(제공자/키/모델) — 변경 즉시 저장 ─────────────────────
  setAIProvider: (provider) => {
    set((st) => ({ ai: { ...st.ai, provider } }));
    void persistSettings(get);
  },
  setAIKey: (provider, key) => {
    set((st) => ({ ai: { ...st.ai, keys: { ...st.ai.keys, [provider]: key } } }));
    void persistSettings(get);
  },
  setAIModel: (provider, model) => {
    set((st) => ({ ai: { ...st.ai, models: { ...st.ai.models, [provider]: model } } }));
    void persistSettings(get);
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
  const { typography, userFonts, ai, keymap, customPresets, reading } = get();
  await window.paperAPI.saveSettings({ typography, fonts: userFonts, ai, keymap, customPresets, reading });
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
