// 프리셋 공유 — 타이포그래피 설정을 붙여넣기 가능한 코드/링크로 인코딩·디코딩.
// 사용자 선택: 공유 프리셋은 "타이포만" 담는다(단축키·형광펜색 제외).
import { DEFAULT_TYPOGRAPHY, type Typography } from "../store/typography";

export interface SavedPreset {
  id: string;
  name: string;
  typography: Typography;
}

const PREFIX = "galpi-preset-v1:";

// 알려진 키만 통과시켜 타입 안전 + 외부 코드 신뢰 방지(§1.2 정신).
export function sanitizeTypography(raw: unknown): Typography {
  const t = { ...DEFAULT_TYPOGRAPHY };
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(DEFAULT_TYPOGRAPHY) as (keyof Typography)[]) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === typeof DEFAULT_TYPOGRAPHY[k]) {
        (t as Record<string, unknown>)[k] = v;
      }
    }
  }
  return t;
}

function toB64(s: string): string {
  // UTF-8 안전 base64 (한글 라벨 대응)
  return btoa(unescape(encodeURIComponent(s)));
}
function fromB64(s: string): string {
  return decodeURIComponent(escape(atob(s)));
}

export function encodePreset(name: string, typography: Typography): string {
  const payload = { v: 1, name: name.slice(0, 80), typography: sanitizeTypography(typography) };
  return PREFIX + toB64(JSON.stringify(payload));
}

export interface DecodedPreset {
  name: string;
  typography: Typography;
}

// 붙여넣은 코드/링크에서 프리셋 복원. PREFIX 앞뒤에 다른 텍스트(URL 래퍼 등)가 있어도 관대하게 처리.
export function decodePreset(input: string): DecodedPreset | null {
  if (!input) return null;
  const idx = input.indexOf(PREFIX);
  if (idx < 0) return null;
  let body = input.slice(idx + PREFIX.length).trim();
  body = body.replace(/[^A-Za-z0-9+/=].*$/s, ""); // base64 뒤 잡텍스트 제거
  try {
    const obj = JSON.parse(fromB64(body)) as { name?: unknown; typography?: unknown };
    return {
      name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : "공유 프리셋",
      typography: sanitizeTypography(obj.typography),
    };
  } catch {
    return null;
  }
}
