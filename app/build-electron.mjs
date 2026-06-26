// Electron main/preload 를 esbuild 로 CommonJS 번들. dev: --watch + electron 재기동.
import { build, context } from "esbuild";
import { spawn } from "node:child_process";
import electronPath from "electron";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron"],
  sourcemap: watch,
  outdir: "dist-electron",
  // package.json 이 "type":"module" 이라 .js 는 ESM 으로 취급됨.
  // CommonJS 번들은 .cjs 로 내보내 require 사용 가능하게.
  outExtension: { ".js": ".cjs" },
};

const entries = {
  ...common,
  entryPoints: { main: "electron/main.ts", preload: "electron/preload.ts" },
};

if (!watch) {
  await build(entries);
  process.exit(0);
}

// dev: watch + Vite 가 준비되면 Electron 기동, 재빌드 시 재기동.
let electronProc = null;
function startElectron() {
  if (electronProc) electronProc.kill();
  electronProc = spawn(electronPath, ["."], { stdio: "inherit", env: process.env });
}

const ctx = await context({
  ...entries,
  plugins: [
    {
      name: "restart-electron",
      setup(b) {
        b.onEnd(() => {
          // Vite dev 서버(5123)가 떠 있어야 main 이 로드 성공. 약간 지연 후 기동.
          setTimeout(startElectron, 800);
        });
      },
    },
  ],
});
await ctx.watch();
