// 사전 견적 (§2.4). 블록 타입별 chars/token 계수 — 단일 계수 chars÷4 를 쓰면
// 수식·표가 많은 논문에서 2배 이상 과소견적한다.
// 절대값은 ±10% 오차가 있어 원장의 est_in vs usage.in 으로 EWMA 보정한다.
import type { TokenUsage } from "./types";

export type BlockKind = "para" | "title" | "footnote" | "list" | "formula" | "table" | "other";

const CHARS_PER_TOKEN: Record<BlockKind, number> = {
  para: 4.5,
  title: 4.1,
  footnote: 3.8,
  list: 3.2,
  formula: 2.1,
  table: 1.8,
  other: 4.0,
};

// 한국어 출력은 영문 대비 토큰 1.13~1.17배 (§2.3).
export const KO_OUT_RATIO = 1.15;

// **문장 정렬은 영문을 되돌려받는다.** D13 의 왕복 제약 때문에 모델이 한국어와 함께
// 원문 앵커까지 출력하므로 출력이 "한국어만" 견적의 몇 배가 된다.
// 2026-08-26 실측(32쪽 · 26배치 · agy): 한국어만 견적 대비 **2.41배**.
// 이걸 안 세면 문서 번역 견적이 통째로 절반으로 나온다(실측: 견적 1.17% / 실제 2.26%).
const FEATURE_OUT_RATIO: Record<string, number> = {
  "translate.blocks": KO_OUT_RATIO * 2.41,
  // 앵커가 앞 4단어뿐이라 되돌아오는 양이 훨씬 적다. 실측 전 잠정값 — outBias 가 보정한다.
  "translate.blocks.prefix": KO_OUT_RATIO * 1.35,
};

// 견적 규칙 버전. **계수를 고치면 반드시 올려라.**
// 원장의 est_out 은 기록 시점 계수로 계산된 값이라, 계수를 바꾼 뒤 옛 행으로 EWMA 를 복원하면
// 새 계수 위에 옛 편차가 한 번 더 곱해진다(2.41 을 고쳤는데 다시 2.41 을 학습 → 5.8배).
export const EST_RULES_VERSION = 2;

// 대화·요약은 출력이 입력에 비례하지 않는다 — 이력 4만 자를 실어도 답은 몇백 토큰이다.
// 비율로 두면 긴 대화에서 출력 견적이 수만 토큰으로 튄다. 고정값에 기능별 EWMA(outBias)만 곱한다. 실측 전 잠정값.
const FEATURE_OUT_FIXED: Record<string, number> = {
  chat: 700,
  "summary.doc": 2500,
};

export function outRatioFor(feature: string): number {
  return FEATURE_OUT_RATIO[feature] ?? KO_OUT_RATIO;
}

// agy 는 턴마다 에이전트 시스템 프롬프트가 다시 들어간다. 실측 3,885~4,090 토큰.
// 이걸 안 세면 견적이 30배 어긋나고 EWMA 가 REST 쪽 보정까지 망가뜨린다.
export const AGY_TURN_OVERHEAD = 3900;

export interface EstimateInput {
  text: string;
  kind?: BlockKind;
}

// 보정 계수는 **백엔드별로 따로** 둔다. 오버헤드 구조가 완전히 다르다.
const bias = new Map<string, number>();
const ALPHA = 0.2;

export function observe(backend: string, estIn: number, actualIn: number): void {
  if (estIn <= 0 || actualIn <= 0) return;
  const ratio = actualIn / estIn;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 10) return;
  bias.set(backend, (1 - ALPHA) * currentBias(backend) + ALPHA * ratio);
}
export function currentBias(backend: string): number {
  return bias.get(backend) ?? 1;
}

// 출력 보정은 **기능별**로 따로 둔다. 같은 백엔드라도 선택 번역(한국어만)과
// 블록 정렬 번역(영문 왕복)은 출력량이 2배 넘게 다르다.
const outBias = new Map<string, number>();
export function observeOut(feature: string, estOut: number, actualOut: number): void {
  if (estOut <= 0 || actualOut <= 0) return;
  const ratio = actualOut / estOut;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 10) return;
  outBias.set(feature, (1 - ALPHA) * currentOutBias(feature) + ALPHA * ratio);
}
export function currentOutBias(feature: string): number {
  return outBias.get(feature) ?? 1;
}

export function allBias(): Record<string, number> {
  return { ...Object.fromEntries(bias), ...Object.fromEntries([...outBias].map(([k, v]) => [`out:${k}`, v])) };
}

export function tokensOf(text: string, kind: BlockKind = "para"): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN[kind]);
}

export interface EstimateOpts {
  backend?: string;
  systemText?: string;
  outRatio?: number;
  /** 주면 기능별 출력 계수 + 기능별 EWMA 보정을 함께 쓴다. */
  feature?: string;
}

// 시스템 프롬프트 + 본문 → 입력/출력 견적. 출력은 한국어 번역 기준.
export function estimate(parts: EstimateInput[], opts: EstimateOpts = {}): Pick<TokenUsage, "in" | "out"> {
  const backend = opts.backend ?? "rest";
  let body = 0;
  for (const p of parts) body += tokensOf(p.text, p.kind ?? "para");
  const overhead = tokensOf(opts.systemText ?? "", "para") + (backend === "agy" ? AGY_TURN_OVERHEAD : 0);
  const k = currentBias(backend);
  const feature = opts.feature ?? "";
  const ratio = opts.outRatio ?? outRatioFor(feature);
  return {
    in: Math.round((overhead + body) * k),
    // 출력은 입력 보정계수(k)를 곱하지 않는다 — k 는 에이전트 오버헤드까지 포함한 **입력** 편차다.
    out: Math.round((FEATURE_OUT_FIXED[feature] ?? body * ratio) * currentOutBias(feature)),
  };
}
