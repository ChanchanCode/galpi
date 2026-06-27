// electron-builder afterPack 훅 — 코드 서명 인증서가 없을 때(identity:null) 앱 번들을
// 제대로 '애드혹(ad-hoc)' 서명한다. 안 하면 Apple Silicon 에서 번들 서명이 깨진 채로 남아
// "손상되었습니다(damaged)" 로 실행 자체가 막힌다. 애드혹 서명이면 Gatekeeper 우회 후 실행 가능.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  // --force: 기존(깨진) 서명 덮어쓰기, --deep: 내부 프레임워크/헬퍼까지, -s -: 애드혹
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  // 검증(실패 시 빌드 중단)
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
  console.log(`  • ad-hoc signed: ${appPath}`);
};
