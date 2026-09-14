// agy 웜 스페어 풀 (§2.8).
//
// 상주 단일 세션을 쓰지 않는 이유: agy 는 턴마다 대화 이력을 통째로 재전송한다.
// 실측 3턴 입력 3,885 → 3,985 → 4,090. 짧은 문장이라 100 토큰씩이지만
// 전문 번역 배치(턴당 3k in / 3.5k out)면 총 입력이 단순합의 약 5배로 튄다.
// agy 에는 대화를 비우는 이벤트도 플래그도 없다.
//
// 그래서: 프로세스를 미리 init 까지 데워 두고(5.9~6.2초, 임계 경로 밖)
// 무상태 턴은 **한 프로세스당 1턴만** 쓰고 폐기한다. TTFT 1.6초 + 이력 오버헤드 0.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import { DEFAULT_MODEL, agyCwd, agyEnv, findAgy, gcConversations, noteConversation } from "./agy";
import { AIError, ZERO_USAGE, type TokenUsage } from "./types";

const INIT_TIMEOUT_MS = 45_000;
const TURN_TIMEOUT_MS = 180_000;
const MAX_TURN_TIMEOUT_MS = 25 * 60_000;
const IDLE_KILL_MS = 5 * 60_000; // 유휴 스페어는 5분 뒤 정리 (개당 RSS 165MB)
const BACKOFF_MS = [0, 1_000, 4_000, 15_000];
// agy 자체 대기 한도(기본 5m)가 프로세스 시작부터 세는지 턴마다 세는지 확인 못 했다.
// 스페어는 5분까지 놀다가 턴을 받으므로 기본값이면 긴 턴이 agy 손에 먼저 끊길 수 있다 → 넉넉히 두고
// 실제 한도는 우리 타이머(턴 타임아웃·유휴 정리)가 건다.
const PRINT_TIMEOUT = "30m";

export interface AgyTurnResult {
  text: string;
  usage: TokenUsage;
}

/** agent = 에이전트 이름, addDirs = view_file 허용 폴더(--add-dir), accountHome = 계정 HOME, turnTimeoutMs = 기본 턴 한도 */
export interface AgyPoolOptions {
  agent: string;
  addDirs?: string[];
  accountHome: string;
  turnTimeoutMs?: number;
}

interface Session {
  proc: ChildProcessWithoutNullStreams;
  model: string;
  ready: Promise<void>;
  bornAt: number;
  used: boolean;
  dead: boolean;
  conversationId: string;
  onEvent: ((ev: string, body: any) => void) | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

// 살아 있는 세션 전부(스페어·턴 중, 폐기된 풀의 턴 포함) — 청소가 쓰는 중인 대화 db 를 지우지 않게.
const live = new Set<Session>();

// 세션을 버릴 때마다 대화 db(~540KB)가 남는다. 모아서 한 번에 지운다.
// 우리가 만든 id 만 대상이라 사용자 본인 기록은 건드리지 않는다.
let sweepTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    void gcConversations({ keepIds: liveConversationIds() }).catch(() => {});
  }, 10_000);
  sweepTimer.unref?.();
}
export function liveConversationIds(): string[] {
  return [...live].map((s) => s.conversationId).filter(Boolean);
}

export class AgyPool {
  private spares: Session[] = [];
  private spawning = 0;
  private consecutiveFailures = 0;
  private lastError = "";
  private disposed = false;

  constructor(
    readonly opts: AgyPoolOptions,
    private model = DEFAULT_MODEL,
    private spareTarget = 1,
  ) {}

  get stats(): { spares: number; spawning: number; failures: number; lastError: string } {
    return { spares: this.spares.length, spawning: this.spawning, failures: this.consecutiveFailures, lastError: this.lastError };
  }

  get currentModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    if (model === this.model) return;
    this.model = model;
    // 모델이 바뀌면 데워 둔 스페어는 못 쓴다.
    for (const s of this.spares) this.kill(s);
    this.spares = [];
  }

  // 미리 데워 둔다. 실패해도 조용히 — 다음 요청 때 다시 시도한다.
  warm(): void {
    if (this.disposed) return;
    while (this.spares.length + this.spawning < this.spareTarget) void this.spawnSpare();
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.spares) this.kill(s);
    this.spares = [];
  }

  private async spawnSpare(): Promise<void> {
    const backoff = BACKOFF_MS[Math.min(this.consecutiveFailures, BACKOFF_MS.length - 1)];
    this.spawning += 1;
    try {
      if (backoff) await new Promise((r) => setTimeout(r, backoff));
      if (this.disposed) return;
      const s = await this.create();
      this.consecutiveFailures = 0;
      // 기동 6초 사이에 풀이 폐기됐으면(계정 전환 등) 넣지 말고 버린다 — 안 그러면 5분간 고아로 산다.
      if (this.disposed) return this.kill(s);
      s.idleTimer = setTimeout(() => {
        this.spares = this.spares.filter((x) => x !== s);
        this.kill(s);
      }, IDLE_KILL_MS);
      this.spares.push(s);
    } catch (err) {
      this.consecutiveFailures += 1;
      this.lastError = String((err as Error)?.message ?? err);
    } finally {
      this.spawning -= 1;
    }
  }

  private async create(): Promise<Session> {
    const bin = findAgy();
    if (!bin) throw new AIError("config", "agy 실행 파일을 찾지 못했습니다.");
    const cwd = agyCwd();
    await fs.mkdir(cwd, { recursive: true });
    const env = await agyEnv(this.opts.accountHome);
    const args = ["--print=", "--agent", this.opts.agent, "--model", this.model];
    // --add-dir 만 주면 그 안의 파일은 권한 프롬프트 없이 view_file 로 읽힌다(실측).
    // --dangerously-skip-permissions 는 쓰지 않는다 — 폴더 밖·다른 도구까지 풀린다.
    for (const d of this.opts.addDirs ?? []) args.push("--add-dir", d);
    args.push("--print-timeout", PRINT_TIMEOUT, "--input-format", "stream-json", "--output-format", "stream-json");
    const proc = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env }) as ChildProcessWithoutNullStreams;

    const s: Session = { proc, model: this.model, ready: null as any, bornAt: Date.now(), used: false, dead: false, conversationId: "", onEvent: null, idleTimer: null };
    live.add(s);

    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString().slice(0, 2000)));
    // 죽은 프로세스의 stdin 에 쓰면 EPIPE 가 **비동기 error 이벤트**로 온다 — 리스너가 없으면 main 이 죽는다.
    proc.stdin.on("error", () => {});
    proc.on("close", () => {
      s.dead = true;
      live.delete(s);
      s.onEvent?.("__closed", { stderr });
    });
    proc.on("error", (e) => {
      s.dead = true;
      live.delete(s);
      s.onEvent?.("__closed", { stderr: String(e) });
    });

    // NDJSON 한 줄 = 이벤트 하나. {"event":"<이름>","<이름>":{…}} 형태다.
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let j: any;
        try {
          j = JSON.parse(line);
        } catch {
          continue; // agy 가 섞어 내는 비-JSON 줄은 무시
        }
        const ev = j.event ?? j.type;
        // conversation_id 는 이벤트 **최상위**에 온다(init 기준). 본문에 얹어 준다.
        if (ev) s.onEvent?.(ev, { conversation_id: j.conversation_id, ...(j[ev] ?? {}) });
      }
    });

    s.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.kill(s);
        reject(new AIError("network", `agy 기동 시간 초과(${INIT_TIMEOUT_MS / 1000}초). ${stderr.slice(0, 200)}`));
      }, INIT_TIMEOUT_MS);
      s.onEvent = (ev, body) => {
        if (ev === "init") {
          clearTimeout(timer);
          s.onEvent = null;
          // init 에 conversation_id 가 온다 — 나중에 이 대화 db 만 골라 지우기 위해 기록.
          const cid = String(body.conversation_id ?? "");
          if (cid) {
            s.conversationId = cid;
            void noteConversation(cid, this.opts.accountHome);
          }
          resolve();
        } else if (ev === "__closed") {
          clearTimeout(timer);
          s.onEvent = null;
          // 파이프 stdin 이면 미로그인은 0.6초 만에 여기로 떨어진다.
          const auth = /authentication required|log in|authentication failed/i.test(body.stderr ?? "");
          reject(
            auth
              ? new AIError("auth", "agy 로그인이 필요합니다. 터미널에서 `agy` 를 한 번 실행하세요.")
              : new AIError("network", `agy 가 기동 중 종료됐습니다. ${(body.stderr ?? "").slice(0, 200)}`),
          );
        }
      };
    });
    await s.ready;
    return s;
  }

  // 한 턴도 안 쓴 세션은 이력이 없다 → 스페어로 돌려 재사용한다.
  private recycle(s: Session): void {
    if (s.dead || s.used || s.model !== this.model || this.disposed) return this.kill(s);
    s.idleTimer = setTimeout(() => {
      this.spares = this.spares.filter((x) => x !== s);
      this.kill(s);
    }, IDLE_KILL_MS);
    this.spares.push(s);
  }

  private kill(s: Session): void {
    if (s.conversationId) scheduleSweep();
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = null;
    s.onEvent = null;
    if (!s.dead) {
      s.dead = true;
      try {
        s.proc.stdin.end();
      } catch {
        /* 이미 닫힘 */
      }
      s.proc.kill();
    }
  }

  private async acquire(): Promise<Session> {
    const s = this.spares.shift();
    if (s && !s.dead && s.model === this.model) {
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.idleTimer = null;
      this.warm(); // 뒤에서 대체분을 데운다
      return s;
    }
    if (s) this.kill(s);
    const fresh = await this.create();
    this.consecutiveFailures = 0;
    this.warm();
    return fresh;
  }

  // 스페어가 없으면 기동에 6초(최악 45초) 걸린다 — 그동안 들어온 취소는 **기다리지 않고 바로** 돌려준다.
  // 뒤늦게 뜬 세션은 아직 아무것도 안 썼으니 깨끗하다 → 버리지 말고 스페어로 돌린다.
  private acquireAbortable(signal: AbortSignal): Promise<Session> {
    return new Promise<Session>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(new AIError("canceled", "중단됨"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.acquire().then(
        (s) => {
          signal.removeEventListener("abort", onAbort);
          if (settled) return this.recycle(s);
          settled = true;
          resolve(s);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          if (settled) return;
          settled = true;
          reject(err);
        },
      );
    });
  }

  // 한 턴. 세션은 쓰고 버린다(이력 누적 방지).
  async runTurn(prompt: string, signal: AbortSignal, onDelta: (t: string) => void, turnTimeoutMs?: number): Promise<AgyTurnResult> {
    if (signal.aborted) throw new AIError("canceled", "중단됨");
    const line = serializeTurn(prompt);
    const limit = Math.min(MAX_TURN_TIMEOUT_MS, Math.max(5_000, turnTimeoutMs ?? this.opts.turnTimeoutMs ?? TURN_TIMEOUT_MS));
    const s = await this.acquireAbortable(signal);
    // 이미 abort 된 signal 에 addEventListener 를 걸면 영영 안 불린다 → 여기서 한 번 더 본다.
    if (signal.aborted) {
      this.recycle(s);
      throw new AIError("canceled", "중단됨");
    }
    s.used = true;
    try {
      return await new Promise<AgyTurnResult>((resolve, reject) => {
        let text = "";
        const usage: TokenUsage = { ...ZERO_USAGE };
        let sawUsage = false;
        const finish = (fn: () => void) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          s.onEvent = null;
          fn();
        };
        const timer = setTimeout(
          // timeout 표시 — 채팅은 5분 기다린 턴을 조용히 두 번 더 돌리면 안 된다(service 가 본다).
          () => finish(() => reject(Object.assign(new AIError("network", `agy 턴 시간 초과(${Math.round(limit / 1000)}초)`), { timeout: true }))),
          limit,
        );
        const onAbort = () => finish(() => reject(new AIError("canceled", "중단됨")));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) return onAbort(); // 등록 직전에 취소됐을 수 있다

        s.onEvent = (ev, body) => {
          if (ev === "step_update" && body.step_type === "agent_response") {
            if (body.text_delta) {
              text += body.text_delta;
              onDelta(body.text_delta);
            }
            // **턴별 usage 는 여기다.** result.usage 는 누적이라 쓰면 회계가 부풀려진다.
            if (body.state === "DONE" && body.usage) {
              addUsage(usage, body.usage);
              sawUsage = true;
            }
          } else if (ev === "result") {
            if (body.status === "SUCCESS") {
              // 델타를 하나도 못 받은 경우를 대비해 최종 응답으로 보강
              if (!text && typeof body.response === "string") text = body.response;
              finish(() => resolve({ text, usage: sawUsage ? usage : { ...ZERO_USAGE } }));
            } else {
              finish(() => reject(classifyAgyError(String(body.error ?? "알 수 없는 오류"))));
            }
          } else if (ev === "__closed") {
            finish(() => reject(new AIError("network", `agy 세션이 끊겼습니다. ${(body.stderr ?? "").slice(0, 200)}`)));
          }
        };

        try {
          s.proc.stdin.write(line);
        } catch (err) {
          finish(() => reject(new AIError("network", `agy 입력 실패: ${String(err)}`)));
        }
      });
    } finally {
      this.kill(s); // 이력 누적을 막으려면 반드시 버린다
      this.warm();
    }
  }
}

// ── 풀 레지스트리 ─────────────────────────────────────────────────────
// 키 = 계정 HOME | 에이전트 | add-dir. 번역(galpi)과 채팅(galpi-chat + 문서 폴더)은 스페어를 섞어 쓸 수 없다 —
// 에이전트·도구·권한 범위가 프로세스 기동 인자로 고정되기 때문이다.
const pools = new Map<string, AgyPool>();

export function poolKey(o: AgyPoolOptions): string {
  return `${o.accountHome}|${o.agent}|${(o.addDirs ?? []).join(",")}`;
}

export function getPool(o: AgyPoolOptions, model: string): AgyPool {
  const key = poolKey(o);
  let p = pools.get(key);
  if (!p) pools.set(key, (p = new AgyPool(o, model)));
  else p.setModel(model);
  return p;
}

export function findPool(o: AgyPoolOptions): AgyPool | null {
  return pools.get(poolKey(o)) ?? null;
}

/** 계정 전환 등 — 모든 스페어를 버린다. 진행 중인 턴은 끝까지 가고 그 세션도 버려진다. */
export function disposeAllPools(): void {
  for (const p of pools.values()) p.dispose();
  pools.clear();
}

// **깨진 줄 하나면 세션 전체가 rc=1 로 즉사한다**(실측). 쓰기 전에 왕복 검증한다.
export function serializeTurn(prompt: string): string {
  const obj = { event: "user", message: { content: prompt } };
  const line = JSON.stringify(obj);
  if (line.includes("\n") || line.includes("\r")) throw new AIError("parse", "직렬화에 개행이 섞였습니다.");
  let back: any;
  try {
    back = JSON.parse(line);
  } catch {
    throw new AIError("parse", "직렬화 검증 실패.");
  }
  if (back?.message?.content !== prompt) throw new AIError("parse", "직렬화 왕복이 원문과 다릅니다.");
  return line + "\n";
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// agy usage → 앱 정규형. REST 와 같은 규칙: in 은 캐시 미적중분만.
// (thinking 이 output 에 포함되는지는 실측에서 둘 다 0 이라 미확인 — 별도 필드로 오므로 배타로 본다.)
function addUsage(dst: TokenUsage, u: any): void {
  const cache = n(u.cache_read_tokens);
  dst.in += Math.max(0, n(u.input_tokens) - cache);
  dst.out += n(u.output_tokens);
  dst.think += n(u.thinking_tokens);
  dst.cache_read += cache;
}

function classifyAgyError(msg: string): AIError {
  if (/RESOURCE_EXHAUSTED|quota|rate.?limit|429/i.test(msg)) return new AIError("rate_limit", `agy 한도: ${msg.slice(0, 160)}`);
  if (/authentication|unauthorized|login/i.test(msg)) return new AIError("auth", `agy 인증: ${msg.slice(0, 160)}`);
  if (/decode stream input/i.test(msg)) return new AIError("parse", `agy 입력 해석 실패: ${msg.slice(0, 160)}`);
  if (/cancelled|canceled/i.test(msg)) return new AIError("canceled", "중단됨");
  if (/5\d\d|unavailable|overloaded|internal/i.test(msg)) return new AIError("server", `agy 서버: ${msg.slice(0, 160)}`);
  return new AIError("network", `agy: ${msg.slice(0, 160)}`);
}
