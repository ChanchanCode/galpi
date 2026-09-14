// 동시성 제한 큐 — 추출 큐(extractQueue)와 같은 발상, AI 호출용.
// 대기 중인 작업은 id 로 취소해 실행조차 하지 않는다.
//
// **우선순위가 필요한 이유**: 전문 번역 배치가 큐를 채우면 사용자가 T 키로 부른 선택 번역이
// 배치 뒤로 밀린다. 배치는 백그라운드지만 선택 번역은 사람이 화면 앞에서 기다리고 있다.
interface Waiter {
  id: string;
  priority: number;
  seq: number;
  start: () => void;
  drop: (reason: Error) => void;
}

export const PRIORITY_INTERACTIVE = 10;
export const PRIORITY_BATCH = 0;

export class JobQueue {
  private active = 0;
  private waiting: Waiter[] = [];
  private seq = 0;
  constructor(private limit: number) {}

  get stats(): { active: number; waiting: number; limit: number } {
    return { active: this.active, waiting: this.waiting.length, limit: this.limit };
  }

  async run<T>(id: string, fn: () => Promise<T>, priority = PRIORITY_INTERACTIVE): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        this.waiting.push({ id, priority, seq: this.seq++, start: resolve, drop: reject });
        // 우선순위 내림차순, 같으면 먼저 온 순서
        this.waiting.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      });
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) next.start();
    }
  }

  // 아직 시작 안 한 작업만 제거. 실행 중이면 false (호출자가 AbortController 로 끊는다).
  cancelWaiting(id: string, reason: Error): boolean {
    const i = this.waiting.findIndex((w) => w.id === id);
    if (i < 0) return false;
    const [w] = this.waiting.splice(i, 1);
    w.drop(reason);
    return true;
  }

  // 접두사로 여러 개 한꺼번에 (배치 잡 취소용)
  cancelWaitingPrefix(prefix: string, reason: Error): number {
    const keep: Waiter[] = [];
    let n = 0;
    for (const w of this.waiting) {
      if (w.id.startsWith(prefix)) {
        w.drop(reason);
        n += 1;
      } else keep.push(w);
    }
    this.waiting = keep;
    return n;
  }
}
