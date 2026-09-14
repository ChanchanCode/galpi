// 자동 업데이트 — 미서명(애드혹) 앱이라 electron-updater(Squirrel.Mac)는 못 쓴다(서명 필수).
// 대신 릴리스의 .zip 을 백그라운드로 받아 풀어 두고, 앱이 끝난 뒤 작은 셸 스크립트가 번들을 갈아 끼운다.
//
//   실행 2.5초 뒤 확인 → 새 버전이면 zip 다운로드·해제·검증(조용히) → "재시작" / "나중에"
//   나중에 → 종료할 때 적용(다음 실행이 새 버전). 재시작 → 교체 후 바로 다시 연다.
//
// Node fetch 로 받은 파일에는 격리 속성(quarantine)이 붙지 않아 Gatekeeper 확인 창이 뜨지 않는다.
// 그래도 스크립트가 교체 후 xattr 를 한 번 더 지운다. 번들 폴더에 쓸 수 없으면(권한) 예전 dmg 방식으로 떨어진다.
import { app, dialog, shell, type BrowserWindow } from "electron";
import { execFile, spawn } from "node:child_process";
import { constants as FS } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const RELEASES_REPO = "ChanchanCode/galpi";

export interface ReleaseInfo {
  current: string;
  latest?: string;
  url?: string; // 릴리스 페이지
  dmgUrl?: string;
  zipUrl?: string;
  hasUpdate?: boolean;
  error?: string;
}

// semver-lite 비교 (a>b → 1)
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const current = app.getVersion();
  try {
    const r = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Galpi" },
    });
    if (!r.ok) return { current, error: `릴리스를 찾을 수 없습니다 (${r.status}).` };
    const data = (await r.json()) as {
      tag_name?: string;
      html_url?: string;
      assets?: { name: string; browser_download_url: string }[];
    };
    const latest = (data.tag_name ?? "").replace(/^v/i, "");
    const assets = data.assets ?? [];
    const arch = process.arch === "arm64" ? /arm64/i : /x64|intel/i;
    const pick = (ext: RegExp) =>
      (assets.find((a) => ext.test(a.name) && arch.test(a.name)) ?? assets.find((a) => ext.test(a.name)))?.browser_download_url;
    return {
      current,
      latest,
      url: data.html_url ?? `https://github.com/${RELEASES_REPO}/releases`,
      dmgUrl: pick(/\.dmg$/i),
      zipUrl: pick(/\.zip$/i),
      hasUpdate: !!latest && cmpVersion(latest, current) > 0,
    };
  } catch (err) {
    return { current, error: String(err) };
  }
}

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    );
  });
}

/** 지금 실행 중인 .app 번들 경로. 패키징되지 않았으면 null. */
function currentBundle(): string | null {
  if (!app.isPackaged || process.platform !== "darwin") return null;
  const p = path.resolve(process.execPath, "..", "..", "..");
  return p.endsWith(".app") ? p : null;
}

async function writable(p: string): Promise<boolean> {
  try {
    await fs.access(p, FS.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": "Galpi" } });
  if (!res.ok || !res.body) throw new Error(`다운로드 실패 (${res.status})`);
  const tmp = `${dest}.part`;
  const fh = await fs.open(tmp, "w");
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await fh.write(value);
    }
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, dest);
}

export interface Staged {
  version: string;
  app: string; // 풀어 둔 새 번들
  dir: string; // 스테이징 폴더(교체 후 지운다)
  target: string; // 갈아 끼울 현재 번들
}
let staged: Staged | null = null;
let swapSpawned = false;
let inflight: Promise<Staged | null> | null = null;

/** zip 을 받아 풀고 버전·서명을 확인해 둔다. 실패하면 null. */
async function stage(info: ReleaseInfo, target: string): Promise<Staged | null> {
  if (staged?.version === info.latest) return staged;
  if (inflight) return inflight;
  inflight = (async () => {
    const dir = path.join(app.getPath("userData"), "update", info.latest!);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    const zip = path.join(dir, "update.zip");
    await download(info.zipUrl!, zip);
    const out = path.join(dir, "x");
    await run("/usr/bin/ditto", ["-x", "-k", zip, out]);
    await fs.rm(zip, { force: true });
    const name = (await fs.readdir(out)).find((n) => n.endsWith(".app"));
    if (!name) throw new Error("zip 안에 .app 이 없습니다.");
    const newApp = path.join(out, name);
    const ver = (await run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", path.join(newApp, "Contents", "Info.plist")])).trim();
    if (ver !== info.latest) throw new Error(`버전 불일치 (${ver} ≠ ${info.latest})`);
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", newApp]); // 깨진 번들이면 "손상됨" 으로 안 열린다
    staged = { version: ver, app: newApp, dir, target };
    return staged;
  })()
    .catch((err) => {
      console.warn("[update] 준비 실패:", err);
      return null;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** 교체 스크립트(순수) — pid 가 끝나길 기다렸다가 번들을 바꾼다. 실패하면 옛 번들로 되돌린다. */
export function swapScript(s: Staged, pid: number, relaunch: boolean): string {
  const bak = `${s.target}.old-update`;
  return [
    "#!/bin/bash",
    `while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done`,
    `rm -rf ${q(bak)}`,
    `if mv ${q(s.target)} ${q(bak)}; then`,
    `  if mv ${q(s.app)} ${q(s.target)} || /usr/bin/ditto ${q(s.app)} ${q(s.target)}; then rm -rf ${q(bak)}; else rm -rf ${q(s.target)}; mv ${q(bak)} ${q(s.target)}; fi`,
    "fi",
    `/usr/bin/xattr -dr com.apple.quarantine ${q(s.target)} 2>/dev/null`,
    `rm -rf ${q(s.dir)}`,
    relaunch ? `/usr/bin/open ${q(s.target)}` : "",
    "",
  ].join("\n");
}

/** 앱이 끝나기를 기다렸다가 번들을 바꾸는 스크립트를 띄운다. */
async function spawnSwap(s: Staged, relaunch: boolean): Promise<void> {
  if (swapSpawned) return;
  swapSpawned = true;
  const script = swapScript(s, process.pid, relaunch);
  const file = path.join(app.getPath("userData"), "update", "swap.sh");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, script, { mode: 0o755 });
  spawn("/bin/bash", [file], { detached: true, stdio: "ignore" }).unref();
}

// 나중에를 골랐으면 종료할 때 적용한다. will-quit 에서는 비동기를 기다려 줄 수 없으므로 스크립트를 미리 써 둔다.
let applyOnQuit = false;
app.on("will-quit", (e) => {
  if (!applyOnQuit || !staged || swapSpawned) return;
  e.preventDefault();
  void spawnSwap(staged, false).finally(() => app.exit(0)); // before-quit(풀 정리)은 이미 돈 뒤다
});

/** 옛 방식(수동 교체) — 번들 폴더에 쓸 수 없거나 zip 이 없는 릴리스일 때. */
async function manualDmg(win: BrowserWindow, info: ReleaseInfo): Promise<void> {
  const { response } = await dialog.showMessageBox(win, {
    type: "info",
    buttons: ["받기", "나중에"],
    defaultId: 0,
    cancelId: 1,
    message: `새 버전 v${info.latest}`,
    detail: `현재 v${info.current}`,
  });
  if (response !== 0) return;
  try {
    if (!info.dmgUrl) throw new Error("dmg 없음");
    const dest = path.join(app.getPath("downloads"), info.dmgUrl.split("/").pop() || "Galpi-update.dmg");
    await download(info.dmgUrl, dest);
    await shell.openPath(dest);
  } catch {
    if (info.url) void shell.openExternal(info.url);
  }
}

/**
 * 업데이트 확인·적용. interactive=false(실행 시)면 새 버전이 없거나 실패할 때 아무것도 안 띄운다.
 * 반환: 사람이 읽을 짧은 상태(설정 창 표시용).
 */
export async function checkAndApply(win: BrowserWindow, interactive = false, cleanup?: () => void): Promise<{ state: "latest" | "ready" | "manual" | "error"; latest?: string; current: string; error?: string }> {
  const info = await fetchLatestRelease();
  if (info.error) return { state: "error", current: info.current, error: info.error };
  if (!info.hasUpdate || !info.latest) return { state: "latest", current: info.current, latest: info.latest };
  const target = currentBundle();
  const canSwap = !!target && !!info.zipUrl && (await writable(path.dirname(target))) && (await writable(target));
  if (!canSwap) {
    if (!win.isDestroyed()) await manualDmg(win, info);
    return { state: "manual", current: info.current, latest: info.latest };
  }
  const s = await stage(info, target!);
  if (!s) {
    if (interactive && !win.isDestroyed()) await manualDmg(win, info);
    return { state: "error", current: info.current, latest: info.latest, error: "업데이트 준비 실패" };
  }
  if (win.isDestroyed()) {
    applyOnQuit = true;
    return { state: "ready", current: info.current, latest: info.latest };
  }
  const { response } = await dialog.showMessageBox(win, {
    type: "info",
    buttons: ["재시작", "나중에"],
    defaultId: 0,
    cancelId: 1,
    message: `v${s.version} 업데이트 준비됨`,
    detail: `현재 v${info.current} · 나중에를 누르면 종료할 때 적용`,
  });
  if (response === 0) {
    await spawnSwap(s, true);
    cleanup?.(); // app.exit 는 before-quit 훅을 건너뛴다 — agy 스페어 정리를 직접
    app.exit(0);
  } else {
    applyOnQuit = true;
  }
  return { state: "ready", current: info.current, latest: info.latest };
}
