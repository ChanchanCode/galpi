// accounts.ts 결정적 검증 — 가짜 저장소·가짜 홈으로 별칭 검증·목록·경로 탈출 차단·로그인 스크립트를 본다.
// 키체인(security)은 건드리지 않는다: 저장소 밖 HOME 거부와 키체인이 없는 계정 경로만 확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const A = require(path.join(import.meta.dirname, "..", "dist-test", "accounts.cjs"));

function fakeRoots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "galpi-acct-"));
  const home = path.join(base, "home");
  const store = path.join(base, "store");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  A.setAccountRoots({ home, store });
  return { base, home, store };
}

function mkAcct(store, alias, { email, token } = {}) {
  const h = path.join(store, alias);
  fs.mkdirSync(path.join(h, ".gemini", "antigravity-cli"), { recursive: true });
  if (email !== undefined) fs.writeFileSync(path.join(h, ".gemini", ".acct-email"), email);
  if (token !== undefined) fs.writeFileSync(path.join(h, ".gemini", "antigravity-cli", "antigravity-oauth-token"), token);
  return h;
}

test("validAlias — 영문·숫자·_- 1~20자만", () => {
  for (const ok of ["main", "dad", "pyh", "a", "A_b-9", "x".repeat(20)]) assert.equal(A.validAlias(ok), true, ok);
  for (const bad of ["", "x".repeat(21), "..", ".", "a/b", "a b", "한글", "a.b", "../x", null, undefined, 3, {}]) {
    assert.equal(A.validAlias(bad), false, String(bad));
  }
});

test("acctHome — main 은 실제 홈, 잘못된 별칭은 저장소 밖으로 못 나간다", () => {
  const { home, store, base } = fakeRoots();
  assert.equal(A.acctHome("main"), home);
  assert.equal(A.acctHome(""), home);
  assert.equal(A.acctHome(null), home);
  assert.equal(A.acctHome("dad"), path.join(store, "dad"));
  assert.equal(A.acctHome("../../etc"), home);
  assert.equal(A.acctHome("a/b"), home);
  assert.equal(A.isStoreHome(path.join(store, "dad")), true);
  assert.equal(A.isStoreHome(store), false);
  assert.equal(A.isStoreHome(home), false);
  assert.equal(A.isStoreHome(path.join(store, "dad", "sub")), false);
  assert.equal(A.isStoreHome(path.join(store, "..", "home")), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test("normalizeAlias — 폴더가 없거나 잘못된 설정값이면 main", () => {
  const { store, base } = fakeRoots();
  mkAcct(store, "dad");
  assert.equal(A.normalizeAlias("dad"), "dad");
  assert.equal(A.normalizeAlias("ghost"), "main");
  assert.equal(A.normalizeAlias("../x"), "main");
  assert.equal(A.normalizeAlias(undefined), "main");
  fs.rmSync(base, { recursive: true, force: true });
});

test("listAccounts — main 먼저·사전순·이메일·토큰 크기로 로그인 판정", () => {
  const { home, store, base } = fakeRoots();
  fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
  fs.writeFileSync(path.join(home, ".gemini", ".acct-email"), "me@example.com\n");
  mkAcct(store, "pyh", { email: "p@example.com\n", token: "tok" });
  mkAcct(store, "dad", { email: "", token: "" }); // 빈 이메일 → "-", 빈 토큰 → 미로그인
  mkAcct(store, "zed"); // 파일 없음
  fs.mkdirSync(path.join(store, "bad name")); // 잘못된 별칭 폴더는 숨긴다
  fs.mkdirSync(path.join(store, "main")); // main 이름 폴더는 실제 홈과 겹치므로 숨긴다
  fs.writeFileSync(path.join(store, "file.txt"), "x"); // 파일은 계정이 아니다

  const rows = A.listAccounts("pyh");
  assert.deepEqual(rows.map((r) => r.alias), ["main", "dad", "pyh", "zed"]);
  assert.deepEqual(rows[0], { alias: "main", email: "me@example.com", loggedIn: null, current: false });
  assert.deepEqual(rows[1], { alias: "dad", email: "-", loggedIn: false, current: false });
  assert.deepEqual(rows[2], { alias: "pyh", email: "p@example.com", loggedIn: true, current: true });
  assert.deepEqual(rows[3], { alias: "zed", email: "-", loggedIn: false, current: false });
  fs.rmSync(base, { recursive: true, force: true });
});

test("listAccounts — 키체인 토큰 사본도 로그인으로 본다(.bak 은 아니다)", () => {
  const { store, base } = fakeRoots();
  const kc = mkAcct(store, "kc");
  fs.writeFileSync(path.join(kc, ".keychain-token"), "go-keyring-base64:abc=");
  const old = mkAcct(store, "old");
  fs.writeFileSync(path.join(old, ".gemini", "antigravity-cli", "antigravity-oauth-token.bak"), "tok");
  const empty = mkAcct(store, "empty");
  fs.writeFileSync(path.join(empty, ".keychain-token"), "");
  const rows = Object.fromEntries(A.listAccounts("main").map((r) => [r.alias, r.loggedIn]));
  assert.deepEqual(rows, { main: null, empty: false, kc: true, old: false });
  fs.rmSync(base, { recursive: true, force: true });
});

test("listAccounts — 저장소가 없으면 main 만", () => {
  const { store, base } = fakeRoots();
  fs.rmSync(store, { recursive: true, force: true });
  const rows = A.listAccounts("main");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].alias, "main");
  assert.equal(rows[0].current, true);
  fs.rmSync(base, { recursive: true, force: true });
});

test("ensureKeychain — 저장소 밖 HOME(실제 홈 포함)은 아무것도 안 하고 throw 하지 않는다", async () => {
  const { home, store, base } = fakeRoots();
  await A.ensureKeychain(home);
  await A.ensureKeychain(path.join(store, "..", "evil"));
  await A.ensureKeychain(store);
  assert.equal(fs.existsSync(path.join(home, "Library")), false);
  assert.equal(fs.existsSync(path.join(home, ".keychain-boot")), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test("loginScript — gemini-acct 우선, main 은 agy 직접, 경로는 따옴표로", () => {
  const { store, base } = fakeRoots();
  const bin = "/Users/x y/.local/bin/agy";
  const tool = "/Users/x y/.claude/bin/gemini-acct";
  const withTool = A.loginScript("dad", { agyBin: bin, acctTool: tool });
  assert.match(withTool, /^#!\/bin\/zsh\n/);
  assert.ok(withTool.includes(`'${tool}' login dad`));
  const mainTool = A.loginScript("main", { agyBin: bin, acctTool: tool });
  assert.ok(!mainTool.includes("gemini-acct"), "main 은 gemini-acct login 이 거부한다");
  assert.ok(mainTool.includes(`'${bin}'`));
  const noTool = A.loginScript("pyh", { agyBin: bin, acctTool: null });
  assert.ok(noTool.includes(`HOME='${path.join(store, "pyh")}' '${bin}'`));
  const quoted = A.loginScript("pyh", { agyBin: "/tmp/it's/agy", acctTool: null });
  assert.ok(quoted.includes(`'/tmp/it'\\''s/agy'`));
  fs.rmSync(base, { recursive: true, force: true });
});

test("openLogin — 잘못된 별칭은 파일을 만들기 전에 거부", async () => {
  const { base } = fakeRoots();
  const cwd = path.join(base, "cwd");
  const r = await A.openLogin("../x", { cwd, agyBin: "/bin/echo" });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(cwd), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test("sameBoot — 초 단위 10분 안이면 같은 부팅(시계 보정으로 usec·초가 바뀌어도)", () => {
  const stamp = "{ sec = 1794887751, usec = 670321 } Tue Nov 17 12:55:51 2026";
  assert.equal(A.sameBoot(stamp, stamp), true);
  assert.equal(A.sameBoot(stamp, "{ sec = 1794887752, usec = 382089 } Tue Nov 17 12:55:52 2026"), true);
  assert.equal(A.sameBoot(stamp, "{ sec = 1794887763, usec = 0 } Tue Nov 17 12:56:03 2026"), true); // 계정끼리 12초 차
  assert.equal(A.sameBoot(stamp, "{ sec = 1794888350, usec = 0 }"), true); // 599초
  assert.equal(A.sameBoot(stamp, "{ sec = 1794888351, usec = 0 }"), false); // 600초 = 다른 부팅
  assert.equal(A.sameBoot(stamp, "{ sec = 1790608569, usec = 646030 } Tue Sep 29 00:16:09 2026"), false);
  for (const bad of [null, undefined, "", "garbage", "{ sec = , usec = 1 }"]) {
    assert.equal(A.sameBoot(stamp, bad), false, String(bad));
    assert.equal(A.sameBoot(bad, stamp), false, String(bad));
  }
});

test("tokenRestoreCommand — go-keyring 값만 대화형 한 줄로, 따옴표 깨지는 값은 거부", () => {
  const kc = "/Users/a b/.claude/.state/gemini-accounts/pyh/Library/Keychains/login.keychain-db";
  assert.equal(
    A.tokenRestoreCommand("go-keyring-base64:eyJhIjoxfQ==", kc),
    `add-generic-password -U -s gemini -a antigravity -w go-keyring-base64:eyJhIjoxfQ== "${kc}"\n`,
  );
  for (const bad of ["", "a b", "a\nb", 'a"b', "a'b", "a;b", "a$b"]) assert.equal(A.tokenRestoreCommand(bad, kc), null, bad);
  assert.equal(A.tokenRestoreCommand("go-keyring-base64:x", '/tmp/a"b/login.keychain-db'), null);
  assert.equal(A.tokenRestoreCommand("go-keyring-base64:x", "/tmp/a\nb/login.keychain-db"), null);
});

test("syncTokenCopies — 키체인이 없는 계정은 만들지도 지우지도 않는다", async () => {
  const { store, base } = fakeRoots();
  const h = mkAcct(store, "pyh", { token: "tok" });
  await A.syncTokenCopies();
  assert.equal(fs.existsSync(path.join(h, "Library")), false);
  assert.equal(fs.existsSync(path.join(h, ".keychain-boot")), false);
  assert.equal(fs.existsSync(path.join(h, ".keychain-token")), false);
  assert.equal(fs.readFileSync(path.join(h, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "utf8"), "tok");
  fs.rmSync(base, { recursive: true, force: true });
});
