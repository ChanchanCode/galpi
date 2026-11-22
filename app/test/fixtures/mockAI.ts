// Deterministic remote latency/failure stand-in. No model, network, or user data.
export const mockAI = { mode: "ok", calls: [] as { docId: string; ids: string[] }[], active: 0, max: 0, dropped: false };
const running = new Map<string, AbortController>();
export const resolvedBackendId = async () => "qa";
// translateDoc 의 캐시 키 모델 — 실제 service.currentRoute 와 같은 모양.
export const currentRoute = async () => ({ backend: "qa", provider: "qa", model: "qa", auto: true });
export function cancelJobPrefix(prefix: string): void {
  for (const [id, ctrl] of running) if (id.startsWith(prefix)) ctrl.abort();
}
export async function runAIJob(job: { jobId: string; docId: string; text: string }) {
  const ctrl = new AbortController();
  running.set(job.jobId, ctrl);
  const blocks = JSON.parse(job.text) as { id: string; text: string }[];
  mockAI.calls.push({docId:job.docId,ids:blocks.map(b=>b.id)});
  mockAI.max = Math.max(mockAI.max, ++mockAI.active);
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, mockAI.mode === "quota" ? 10 : 60);
      ctrl.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, {once:true});
    });
    if (ctrl.signal.aborted) return {error:{kind:"canceled",message:"중단됨"}};
    if (mockAI.mode === "quota") return {error:{kind:"rate_limit",message:"QA quota exhausted"}};
    const selected = mockAI.mode === "missing" ? [] : blocks.filter((b) => {
      if (mockAI.mode === "note-missing" && b.id.endsWith(':fn:6')) return false;
      if (mockAI.mode === "partial" && b.id === "b0" && !mockAI.dropped) {mockAI.dropped=true;return false;} return true;
    });
    return {text:JSON.stringify(selected.map(b=>({id:b.id,seg:[{en:[b.text],ko:`검증 번역 ${b.id}: 시장 수익률과 투자자의 기대를 분석한다. ${b.text.match(/⟦\d+⟧/g)?.join(" ") ?? ""}`}]}))),
      usage:{in:10,out:10,think:0,cache_read:0,cache_write:0}};
  } finally {running.delete(job.jobId);mockAI.active--;}
}
