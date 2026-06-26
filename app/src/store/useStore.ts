// 앱 상태 + 영속화 (명세 §10). Zustand.
// - 타이포그래피: 문서별 state.json 우선, 없으면 전역 settings.json 기본값.
// - 저장은 디바운스 자동. 사용자 폰트는 전역 settings 에 보관(@font-face 동적 등록).
import { create } from "zustand";
import {
  DEFAULT_TYPOGRAPHY,
  type Typography,
} from "./typography";
import type { UserFont } from "../../electron/preload";

export interface TranslationConfig {
  apiKey: string;
  model: string;
}

interface GlobalSettings {
  typography: Typography;
  fonts: UserFont[];
  translation?: TranslationConfig;
}

const DEFAULT_TRANSLATION: TranslationConfig = { apiKey: "", model: "gemini-2.0-flash" };

interface DocState {
  typography?: Partial<Typography>;
  // highlights 등은 Phase 5 에서 확장
  last_scroll_block?: string;
}

interface Store {
  docId: string | null;
  typography: Typography;
  userFonts: UserFont[];
  globalDefault: Typography;
  translation: TranslationConfig;

  initSession: () => Promise<void>;
  loadDocState: (docId: string) => Promise<void>;
  setTypography: (patch: Partial<Typography>) => void;
  resetToGlobalDefault: () => void;
  saveAsGlobalDefault: () => Promise<void>;
  addUserFonts: () => Promise<void>;
  setTranslationConfig: (patch: Partial<TranslationConfig>) => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useStore = create<Store>((set, get) => ({
  docId: null,
  typography: DEFAULT_TYPOGRAPHY,
  userFonts: [],
  globalDefault: DEFAULT_TYPOGRAPHY,
  translation: DEFAULT_TRANSLATION,

  // 앱 시작 시 전역 설정 로드 (기본 타이포 + 사용자 폰트 + 번역 설정)
  initSession: async () => {
    const g = (await window.paperAPI.loadSettings()) as GlobalSettings | null;
    if (g) {
      set({
        globalDefault: { ...DEFAULT_TYPOGRAPHY, ...g.typography },
        userFonts: g.fonts ?? [],
        translation: { ...DEFAULT_TRANSLATION, ...(g.translation ?? {}) },
      });
    }
  },

  // 문서 열 때: 문서별 state.json 의 타이포 우선, 없으면 전역 기본값
  loadDocState: async (docId) => {
    const s = (await window.paperAPI.loadState(docId)) as DocState | null;
    const base = get().globalDefault;
    set({
      docId,
      typography: { ...base, ...(s?.typography ?? {}) },
    });
  },

  // 실시간 조정 → 즉시 반영 + 디바운스 저장(문서별 state.json)
  setTypography: (patch) => {
    set((st) => ({ typography: { ...st.typography, ...patch } }));
    const { docId, typography } = get();
    if (!docId) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // 기존 state.json 을 보존하며 typography 만 갱신
      window.paperAPI.loadState(docId).then((prev) => {
        const next = { ...((prev as object) ?? {}), typography };
        window.paperAPI.saveState(docId, next);
      });
    }, 400);
  },

  resetToGlobalDefault: () => set({ typography: { ...get().globalDefault } }),

  // 현재 설정을 전역 기본값으로 (새 문서에 적용)
  saveAsGlobalDefault: async () => {
    set({ globalDefault: { ...get().typography } });
    await persistSettings(get);
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
}));

// 전역 settings.json 을 한 곳에서 직렬화 — 부분 저장이 다른 키를 덮어쓰지 않게.
async function persistSettings(get: () => Store): Promise<void> {
  const { globalDefault, userFonts, translation } = get();
  await window.paperAPI.saveSettings({
    typography: globalDefault,
    fonts: userFonts,
    translation,
  });
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
