// 단가표 — 원장에 **기록 시점 단가로 확정**해 넣는다. 소급 재계산 금지(§4.1).
// 단위: USD / 1M 토큰. 모르는 모델은 0 으로 두고 price_v 를 "unknown" 으로 남긴다.
import type { TokenUsage } from "./types";

export const PRICE_VERSION = "2026-08-26";

interface Price {
  in: number;
  out: number;
  cache_read?: number;
  cache_write?: number;
}

// prefix 매칭 — 긴 prefix 가 이긴다.
const TABLE: Record<string, Price> = {
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4, cache_read: 0.025 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5, cache_read: 0.075 },
  "gemini-2.5-pro": { in: 1.25, out: 10, cache_read: 0.31 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6, cache_read: 0.1 },
  "gpt-4.1": { in: 2, out: 8, cache_read: 0.5 },
  "gpt-4o-mini": { in: 0.15, out: 0.6, cache_read: 0.075 },
  "gpt-4o": { in: 2.5, out: 10, cache_read: 1.25 },
  "claude-haiku": { in: 1, out: 5, cache_read: 0.1, cache_write: 1.25 },
  "claude-sonnet": { in: 3, out: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-opus": { in: 15, out: 75, cache_read: 1.5, cache_write: 18.75 },
};

function lookup(model: string): { price: Price | null; key: string } {
  let best = "";
  for (const k of Object.keys(TABLE)) if (model.startsWith(k) && k.length > best.length) best = k;
  return best ? { price: TABLE[best], key: best } : { price: null, key: "" };
}

// agy(구독) 경로는 건당 과금이 아니다 — USD 는 0, 한도 소모는 quota_delta 로 따로 기록한다.
export function costOf(backend: string, model: string, u: TokenUsage): { usd: number; price_v: string } {
  if (backend === "agy") return { usd: 0, price_v: `agy@${PRICE_VERSION}` };
  const { price, key } = lookup(model);
  if (!price) return { usd: 0, price_v: "unknown" };
  const M = 1_000_000;
  const usd =
    (u.in * price.in +
      (u.out + u.think) * price.out +
      u.cache_read * (price.cache_read ?? price.in) +
      u.cache_write * (price.cache_write ?? price.in)) /
    M;
  return { usd: Math.round(usd * 1e8) / 1e8, price_v: `${key}@${PRICE_VERSION}` };
}
