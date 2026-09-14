// agy 다계정 — 그냥 받아쓰기(engine.py acct_home/_ensure_keychain/agy_accounts)·`~/.claude/bin/gemini-acct` 이식.
// 원리: agy 는 설정·자격증명을 전부 $HOME/.gemini 에서 읽는다 → "계정 = HOME 디렉터리 하나".
//       main = 실제 홈, 그 외 = ~/.claude/.state/gemini-accounts/<alias> 가짜 홈.
// **세 앱이 같은 저장소를 쓴다** — 한 번 로그인하면 받아쓰기·gemini-acct·갈피가 공용.
//
// electron 을 import 하지 않는다 — node 테스트(dist-test/accounts.cjs)에서 그대로 돌아야 한다.
// 앱 경로(agyCwd)·agy 바이너리는 호출자가 넘긴다.
import { execFile, spawn } from "node:child_process";
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MAIN_ALIAS = "main";

// 테스트가 가짜 저장소·가짜 홈을 끼울 수 있게 모듈 상태로 둔다(기본은 실제 위치).
let realHome = os.homedir();
let storeRoot = path.join(realHome, ".claude", ".state", "gemini-accounts");

export function setAccountRoots(opts: { home?: string; store?: string }): void {
  if (opts.home) realHome = opts.home;
  if (opts.store) storeRoot = opts.store;
  keychainDone.clear();
}
export function accountStore(): string {
  return storeRoot;
}
export function realHomeDir(): string {
  return realHome;
}

// 별칭은 경로 조각이 된다 — `..`·`/` 가 들어가면 저장소 밖으로 샌다.
export function validAlias(a: unknown): a is string {
  return typeof a === "string" && /^[A-Za-z0-9_-]{1,20}$/.test(a);
}

/** 설정값 → 실제로 쓸 별칭. 잘못됐거나 폴더가 사라진 계정이면 main(받아쓰기 _acct_env 가 None 을 주는 것과 같다). */
export function normalizeAlias(a: unknown): string {
  if (!validAlias(a) || a === MAIN_ALIAS) return MAIN_ALIAS;
  return isDir(path.join(storeRoot, a)) ? a : MAIN_ALIAS;
}

/** gemini-acct 와 동일: main/빈값 = 실제 홈, 그 외 = 저장소/<alias>. 잘못된 별칭은 main 으로(경로 탈출 차단). */
export function acctHome(alias?: string | null): string {
  if (!alias || alias === MAIN_ALIAS || !validAlias(alias)) return realHome;
  return path.join(storeRoot, alias);
}

/** 이 HOME 이 저장소 안의 가짜 홈인가 — 키체인 재생성은 **여기서만** 한다(실제 login 키체인은 절대 건드리지 않는다). */
export function isStoreHome(home: string): boolean {
  const rel = path.relative(storeRoot, path.resolve(home));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.includes(path.sep) && validAlias(rel);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface AccountRow {
  alias: string;
  email: string;
  loggedIn: boolean | null;
  current: boolean;
}

/** main 먼저, 그다음 저장소 폴더 사전순. 로그인 여부는 oauth 토큰 파일 크기로 판정. */
export function listAccounts(current: string): AccountRow[] {
  const homes: [string, string][] = [[MAIN_ALIAS, realHome]];
  try {
    const names = readdirSync(storeRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && validAlias(d.name) && d.name !== MAIN_ALIAS)
      .map((d) => d.name)
      .sort();
    for (const n of names) homes.push([n, path.join(storeRoot, n)]);
  } catch {
    /* 저장소 없음 = main 만 */
  }
  return homes.map(([alias, home]) => {
    let email = "-";
    try {
      email = readFileSync(path.join(home, ".gemini", ".acct-email"), "utf8").trim() || "-";
    } catch {
      /* 모름 */
    }
    // main 은 토큰이 macOS 키체인에 있어 파일로 판정 불가 → null(미상)
    let loggedIn: boolean | null = null;
    if (alias !== MAIN_ALIAS) {
      try {
        loggedIn = statSync(path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")).size > 0;
      } catch {
        loggedIn = false;
      }
    }
    return { alias, email, loggedIn, current: alias === current };
  });
}

// ── 계정 키체인 ─────────────────────────────────────────────────────
// 원리(gemini-acct 2026-08-31 실측): 가짜 홈의 login.keychain-db 는 unlock 이 안 되지만 이 이름만 암묵적
// 기본 키체인으로 잡혀 "저장할 키체인 없음" 팝업이 안 뜬다. 갓 만든 키체인은 그 부팅 동안 저장 가능 →
// **부팅마다 새로 만든다.** 내용물은 agy 캐시일 뿐(토큰 정본은 파일)이라 재생성 손실이 없다.
// 부팅 스탬프 형식(첫 줄, 개행 없음)은 받아쓰기·gemini-acct 와 같아야 서로 재생성을 반복하지 않는다.

function exec(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
        resolve({ code, out: String(stdout ?? "") });
      });
    } catch {
      resolve({ code: -1, out: "" });
    }
  });
}

let bootCache: string | null = null;
const keychainDone = new Set<string>();
const keychainInflight = new Map<string, Promise<void>>();

/** 가짜 홈의 키체인을 이번 부팅용으로 맞춘다. 절대 throw 하지 않는다. 저장소 밖 HOME(=실제 홈)이면 아무것도 안 한다. */
export function ensureKeychain(home: string): Promise<void> {
  if (process.platform !== "darwin" || !isStoreHome(home)) return Promise.resolve();
  const key = path.resolve(home);
  if (keychainDone.has(key)) return Promise.resolve();
  let p = keychainInflight.get(key);
  if (!p) {
    // 같은 홈에 대한 동시 호출이 delete/create 를 겹쳐 돌리면 서로의 키체인을 지운다 → 한 줄로.
    p = doEnsureKeychain(key)
      .catch(() => {})
      .finally(() => keychainInflight.delete(key));
    keychainInflight.set(key, p);
  }
  return p;
}

async function doEnsureKeychain(home: string): Promise<void> {
  if (bootCache === null) {
    const r = await exec("/usr/sbin/sysctl", ["-n", "kern.boottime"], 5000);
    const first = r.code === 0 ? r.out.split("\n")[0] : "";
    if (!first) return;
    bootCache = first;
  }
  const boot = bootCache;
  const kc = path.join(home, "Library", "Keychains", "login.keychain-db");
  const stamp = path.join(home, ".keychain-boot");
  const cur = await fs.readFile(stamp, "utf8").catch(() => null);
  if (existsSync(kc) && cur === boot) {
    keychainDone.add(home);
    return;
  }
  const sec = "/usr/bin/security";
  await fs.mkdir(path.dirname(kc), { recursive: true });
  await exec(sec, ["delete-keychain", kc], 10000);
  await fs.rm(kc, { force: true }).catch(() => {});
  const c = await exec(sec, ["create-keychain", "-p", "", kc], 10000);
  if (c.code !== 0) return;
  await exec(sec, ["set-keychain-settings", kc], 10000);
  await fs.writeFile(stamp, boot, "utf8");
  keychainDone.add(home);
  // create-keychain 이 실계정 검색 목록에 자기를 등록하는 부작용 제거(다른 항목 보존)
  const l = await exec(sec, ["list-keychains", "-d", "user"], 10000);
  if (l.code !== 0) return;
  const keep = l.out
    .split("\n")
    .map((x) => x.trim().replace(/^"|"$/g, ""))
    .filter((x) => x && !x.includes("gemini-accounts"));
  if (keep.length) await exec(sec, ["list-keychains", "-d", "user", "-s", ...keep], 10000);
}

/** alias 계정으로 agy 를 띄울 env. 가짜 홈이면 키체인을 먼저 맞춘다. */
export async function accountEnv(alias: string): Promise<NodeJS.ProcessEnv> {
  const home = acctHome(normalizeAlias(alias));
  await ensureKeychain(home);
  return { ...process.env, HOME: home };
}

// ── 로그인 (터미널) ─────────────────────────────────────────────────
// 앱 안에서는 인가 코드를 stdin 으로 못 넣는다(실측) → .command 스크립트를 Terminal 로 연다.

function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 로그인 스크립트 본문(순수). gemini-acct 가 있으면 그걸로(seed_home·잔량 확인까지 해 준다). main 은 gemini-acct 가 거부하므로 agy 직접. */
export function loginScript(alias: string, opts: { agyBin: string; acctTool?: string | null }): string {
  let cmd: string;
  if (alias !== MAIN_ALIAS && opts.acctTool) {
    cmd = `${sq(opts.acctTool)} login ${alias}`;
  } else if (alias === MAIN_ALIAS) {
    cmd = `cd "$HOME" && ${sq(opts.agyBin)}`;
  } else {
    // 신뢰된 폴더(실제 홈)에서 띄워 신뢰 프롬프트를 피한다 — gemini-acct login 과 같다.
    cmd = `cd "$HOME" && HOME=${sq(acctHome(alias))} ${sq(opts.agyBin)}`;
  }
  return [
    "#!/bin/zsh",
    `echo '[갈피] agy 로그인 (${alias}) — 브라우저가 열리면 구글 계정으로 로그인하세요.'`,
    cmd,
    "echo; echo '끝나면 이 창을 닫으세요.'",
    "",
  ].join("\n");
}

/** 별칭 검증 → (main 이 아니면) 홈 폴더·키체인 준비 → <cwd>/login.command 작성 → Terminal 로 열기. */
export async function openLogin(
  alias: string,
  opts: { cwd: string; agyBin: string | null },
): Promise<{ ok: boolean; error?: string }> {
  if (!validAlias(alias)) return { ok: false, error: "별칭은 영문·숫자·_- 20자 이내" };
  if (process.platform !== "darwin") return { ok: false, error: "macOS 전용" };
  const acctToolPath = path.join(realHome, ".claude", "bin", "gemini-acct");
  const acctTool = existsSync(acctToolPath) ? acctToolPath : null;
  if (!opts.agyBin && !(acctTool && alias !== MAIN_ALIAS)) return { ok: false, error: "agy 실행 파일을 찾지 못했습니다." };
  try {
    if (alias !== MAIN_ALIAS) {
      const home = acctHome(alias);
      await fs.mkdir(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
      await ensureKeychain(home);
    }
    await fs.mkdir(opts.cwd, { recursive: true });
    const sc = path.join(opts.cwd, "login.command");
    await fs.writeFile(sc, loginScript(alias, { agyBin: opts.agyBin ?? "agy", acctTool }), "utf8");
    await fs.chmod(sc, 0o755);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/open", ["-a", "Terminal", sc], { detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}
