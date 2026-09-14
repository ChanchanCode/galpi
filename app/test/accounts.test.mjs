// accounts.ts 결정적 검증 — 가짜 저장소·가짜 홈으로 별칭 검증·목록·경로 탈출 차단·로그인 스크립트를 본다.
// 키체인(security)은 건드리지 않는다: 저장소 밖 HOME 거부 경로만 확인한다.
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
