import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Electron 렌더러용. base="./" 로 file:// 로딩 시 상대경로 자산이 맞게 풀리도록.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5123, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
