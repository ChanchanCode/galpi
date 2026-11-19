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

function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** main 먼저, 그다음 저장소 폴더 사전순. 로그인 여부는 토큰 파일(옛 방식) 또는 키체인 토큰 사본 크기로 판정. */
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
    // main 은 토큰이 실제 login 키체인에 있어 파일로 판정 불가 → null(미상).
    // 가짜 홈은 토큰 파일(옛 방식) 또는 계정 키체인 — 키체인 토큰은 syncToken 이 남긴 사본으로 본다.
    const loggedIn =
      alias === MAIN_ALIAS
        ? null
        : [path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), path.join(home, TOKEN_COPY)].some(
            (f) => fileSize(f) > 0,
          );
    return { alias, email, loggedIn, current: alias === current };
  });
}

// ── 계정 키체인 ─────────────────────────────────────────────────────
// 원리(gemini-acct 2026-08-31 실측): 가짜 홈의 login.keychain-db 는 unlock 이 안 되지만 이 이름만 암묵적
// 기본 키체인으로 잡혀 "저장할 키체인 없음" 팝업이 안 뜬다. 갓 만든 키체인은 그 부팅 동안 저장 가능 →
// **부팅마다 새로 만든다.**
// 토큰은 이 키체인에만 있다(2026-10-26 agy 가 토큰 파일을 키체인으로 옮기고 파일은 .bak) →
// 같은 부팅에서는 절대 지우지 않고, 새로 만든 뒤에는 홈의 사본(.keychain-token)으로 되채운다.
// 부팅 스탬프 형식(첫 줄, 개행 없음)·사본 위치는 받아쓰기(engine.py)·gemini-acct 와 같아야 서로 지우지 않는다.

const SEC = "/usr/bin/security";
const KC_ITEM = ["-s", "gemini", "-a", "antigravity"]; // agy(go-keyring)가 토큰을 넣는 항목(받아쓰기 실측)
const TOKEN_COPY = ".keychain-token";
// go-keyring 이 넣는 값은 "go-keyring-base64:<base64>" — 따옴표 없이 security 대화형 명령줄에 넣어도 되는 글자뿐.
const SAFE_TOKEN = /^[A-Za-z0-9+/=:_.-]+$/;

/** kern.boottime 두 값이 같은 부팅인가. 이 값은 재부팅 없이도 시계 보정 때마다 바뀐다(받아쓰기 실측:
 *  같은 부팅에서 usec 이 바뀌고 계정끼리 12초 차) → 글자 비교로는 키체인을 지워 로그아웃된다.
 *  초 단위로 10분 안이면 같은 부팅으로 본다(받아쓰기 _same_boot·gemini-acct 와 같은 기준). */
export function sameBoot(a: string | null | undefined, b: string | null | undefined): boolean {
  const sec = (v: string | null | undefined): number | null => {
    const m = /\{ sec = (\d+)/.exec(v ?? "");
    return m ? Number(m[1]) : null;
  };
  const x = sec(a);
  const y = sec(b);
  return x !== null && y !== null && Math.abs(x - y) < 600;
}

/** 사본으로 키체인 토큰을 되채우는 `security -i` 입력 한 줄(순수). 토큰을 명령줄 인자로 넘기면 ps 에 보인다 →
 *  go-keyring 과 같이 대화형 stdin 으로 넣는다. 그대로 넣을 수 없는 값이면 null. */
export function tokenRestoreCommand(token: string, kc: string): string | null {
  if (!SAFE_TOKEN.test(token) || /["\\\r\n]/.test(kc)) return null;
  return `add-generic-password -U ${KC_ITEM.join(" ")} -w ${token} "${kc}"\n`;
}

function exec(bin: string, args: string[], timeoutMs: number, input?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    try {
      const child = execFile(bin, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
        resolve({ code, out: String(stdout ?? "") });
      });
      if (input !== undefined) {
        child.stdin?.on("error", () => {}); // 먼저 죽으면 EPIPE — 결과는 콜백이 알린다
        child.stdin?.end(input);
      }
    } catch {
      resolve({ code: -1, out: "" });
    }
  });
}

let bootCache: string | null = null;
async function bootTime(): Promise<string | null> {
  if (bootCache === null) {
    const r = await exec("/usr/sbin/sysctl", ["-n", "kern.boottime"], 5000);
    const first = r.code === 0 ? r.out.split("\n")[0] : "";
    if (first) bootCache = first;
  }
  return bootCache;
}

const keychainInflight = new Map<string, Promise<void>>();

/** 가짜 홈의 키체인을 이번 부팅용으로 맞추고 토큰을 사본과 맞춘다. agy 를 띄우기 전마다 부른다.
 *  절대 throw 하지 않는다. 저장소 밖 HOME(=실제 홈)이면 아무것도 안 한다. */
export function ensureKeychain(home: string): Promise<void> {
  return keychainTask(home, true);
}

/** 목록용 — 이번 부팅의 키체인이 있는 계정만 토큰 사본을 맞춘다. 키체인을 만들거나 지우지 않는다.
 *  터미널에서 막 로그인한 계정은 토큰이 키체인에만 있어서, 사본이 생겨야 목록에서 로그인으로 보인다. */
export async function syncTokenCopies(): Promise<void> {
  if (process.platform !== "darwin") return;
  let names: string[];
  try {
    names = readdirSync(storeRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && validAlias(d.name) && d.name !== MAIN_ALIAS)
      .map((d) => d.name);
  } catch {
    return;
  }
  await Promise.all(names.map((n) => keychainTask(path.join(storeRoot, n), false)));
}

function keychainTask(home: string, create: boolean): Promise<void> {
  if (process.platform !== "darwin" || !isStoreHome(home)) return Promise.resolve();
  const h = path.resolve(home);
  // 같은 홈에 대한 동시 호출이 delete/create 를 겹쳐 돌리면 서로의 키체인을 지운다 → 한 줄로.
  // 만드는 호출은 만들지 않는 호출의 결과를 빌려 쓰지 않는다(그 뒤에도 키체인이 없을 수 있다).
  const key = `${h}\0${create ? "create" : "sync"}`;
  let p = keychainInflight.get(key);
  if (!p) {
    p = doEnsureKeychain(h, create)
      .catch(() => {})
      .finally(() => keychainInflight.delete(key));
    keychainInflight.set(key, p);
  }
  return p;
}

async function doEnsureKeychain(home: string, create: boolean): Promise<void> {
  const boot = await bootTime();
  if (!boot) return;
  const kc = path.join(home, "Library", "Keychains", "login.keychain-db");
  const stamp = path.join(home, ".keychain-boot");
  const cur = await fs.readFile(stamp, "utf8").catch(() => null);
  if (!existsSync(kc) || !sameBoot(cur, boot)) {
    if (!create || !(await newKeychain(kc, stamp, boot))) return;
  }
  await syncToken(home, kc);
}

async function newKeychain(kc: string, stamp: string, boot: string): Promise<boolean> {
  await fs.mkdir(path.dirname(kc), { recursive: true });
  await exec(SEC, ["delete-keychain", kc], 10000);
  await fs.rm(kc, { force: true }).catch(() => {});
  const c = await exec(SEC, ["create-keychain", "-p", "", kc], 10000);
  if (c.code !== 0) return false;
  await exec(SEC, ["set-keychain-settings", kc], 10000);
  await fs.writeFile(stamp, boot, "utf8");
  // create-keychain 이 실계정 검색 목록에 자기를 등록하는 부작용 제거(다른 항목 보존)
  const l = await exec(SEC, ["list-keychains", "-d", "user"], 10000);
  if (l.code === 0) {
    const keep = l.out
      .split("\n")
      .map((x) => x.trim().replace(/^"|"$/g, ""))
      .filter((x) => x && !x.includes("gemini-accounts"));
    if (keep.length) await exec(SEC, ["list-keychains", "-d", "user", "-s", ...keep], 10000);
  }
  return true;
}

/** 키체인 토큰 ↔ 홈의 사본(.keychain-token). 키체인에 있으면 사본을 갱신하고, 비어 있으면(재부팅 뒤 재생성,
 *  다른 앱이 먼저 재생성) 사본으로 되채운다. 사본도 없으면 agy 가 남긴 .bak 을 토큰 파일로 되돌린다 —
 *  agy 가 그 파일을 읽고 키체인으로 다시 옮긴다(받아쓰기 실측). */
async function syncToken(home: string, kc: string): Promise<void> {
  const copy = path.join(home, TOKEN_COPY);
  const r = await exec(SEC, ["find-generic-password", ...KC_ITEM, "-w", kc], 10000);
  const cur = r.code === 0 ? r.out.trim() : "";
  if (cur) {
    if ((await fs.readFile(copy, "utf8").catch(() => null)) !== cur) {
      const tmp = `${copy}.${process.pid}.tmp`;
      await fs.writeFile(tmp, cur, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, copy);
    }
    return;
  }
  const saved = (await fs.readFile(copy, "utf8").catch(() => "")).trim();
  const cmd = saved ? tokenRestoreCommand(saved, kc) : null;
  if (cmd) {
    await exec(SEC, ["-i"], 10000, cmd);
    return;
  }
  const tok = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  if (!existsSync(tok) && existsSync(`${tok}.bak`)) {
    await fs.copyFile(`${tok}.bak`, tok);
    await fs.chmod(tok, 0o600);
  }
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
