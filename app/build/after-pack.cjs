// electron-builder afterPack 훅 — 인증서 없음(identity:null) 시 애드혹 서명.
// 안 하면 Apple Silicon 에서 번들 서명이 깨진 채로 남아 "손상되었습니다(damaged)" 로 실행이 막힌다.
const { execFileSync } = require("node:child_process");
const path = require("node:path");
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
  console.log(`  • ad-hoc signed: ${appPath}`);
};
