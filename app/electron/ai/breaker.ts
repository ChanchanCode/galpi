// 차단기 (H3, §8-3). 429 는 **재시도 대상이 아니라 차단 대상**이다.
// 옛 코드는 429 를 900ms 쉬고 1회 재시도했다 — 한도성 429 면 소모만 늘린다.
//
// 두 층:
//   provider 차단기 — 429/할당량. 리셋 시각까지 그 제공자 전체를 막는다(계정 단위 한도라서).
//   feature  차단기 — 연속 실패 3회면 그 기능을 세션 동안 닫는다.
import { AIError } from "./types";

const DEFAULT_TRIP_MS = 60_000;
const MAX_CONSECUTIVE = 3;

interface State {
  trippedUntil: number;
  reason: string;
  consecutive: number;
  closedForSession: boolean;
}

const states = new Map<string, State>();

function get(key: string): State {
  let s = states.get(key);
  if (!s) states.set(key, (s = { trippedUntil: 0, reason: "", consecutive: 0, closedForSession: false }));
  return s;
}

export function featureRoot(feature: string): string {
  return feature.split(".")[0] || feature;
}

// 호출 직전 게이트. 막혀 있으면 AIError("breaker") 를 던진다.
export function gate(providerKey: string, feature: string): void {
  const now = Date.now();
  for (const key of [providerKey, `feat:${featureRoot(feature)}`]) {
    const s = get(key);
    if (s.closedForSession) {
      throw new AIError("breaker", `연속 실패로 이 기능을 이번 세션 동안 중단했습니다 (${s.reason}). 설정에서 재개할 수 있습니다.`);
    }
    if (s.trippedUntil > now) {
      const sec = Math.ceil((s.trippedUntil - now) / 1000);
      throw new AIError("breaker", `한도/오류로 차단 중입니다. ${sec}초 뒤 다시 시도하세요 (${s.reason}).`, undefined, s.trippedUntil - now);
    }
  }
}

export function onSuccess(providerKey: string, feature: string): void {
  for (const key of [providerKey, `feat:${featureRoot(feature)}`]) {
    const s = get(key);
    s.consecutive = 0;
    s.trippedUntil = 0;
    s.reason = "";
  }
}

export function onFailure(providerKey: string, feature: string, err: AIError): void {
  if (err.kind === "canceled" || err.kind === "breaker") return;
  const p = get(providerKey);
  if (err.kind === "rate_limit") {
    p.trippedUntil = Date.now() + (err.retryAfterMs ?? DEFAULT_TRIP_MS);
    p.reason = err.message.slice(0, 120);
  }
  const f = get(`feat:${featureRoot(feature)}`);
  f.consecutive += 1;
  p.consecutive += 1;
  if (f.consecutive >= MAX_CONSECUTIVE) {
    f.closedForSession = true;
    f.reason = err.message.slice(0, 120);
  }
}

export function reset(key?: string): void {
  if (key) states.delete(key);
  else states.clear();
}

export function snapshot(): Record<string, { trippedForMs: number; reason: string; consecutive: number; closedForSession: boolean }> {
  const now = Date.now();
  const out: Record<string, { trippedForMs: number; reason: string; consecutive: number; closedForSession: boolean }> = {};
  for (const [k, s] of states) {
    if (!s.reason && !s.consecutive && !s.closedForSession) continue;
    out[k] = {
      trippedForMs: Math.max(0, s.trippedUntil - now),
      reason: s.reason,
      consecutive: s.consecutive,
      closedForSession: s.closedForSession,
    };
  }
  return out;
}
