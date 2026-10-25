import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Settings } from "./settings";

export type ProcessingMode = "balanced" | "auto" | "fast";
export interface ResourceSnapshot { cores: number; availableGB: number; load: number }

export function processingMode(raw: unknown): ProcessingMode {
  return raw === "balanced" || raw === "fast" ? raw : "auto";
}

// Re-evaluate between batches. Do not start more processes under memory pressure.
export function processingProfile(mode: ProcessingMode, resources: ResourceSnapshot) {
  const cores = Math.max(1, resources.cores);
  const busy = resources.load / cores;
  const spare = resources.availableGB >= 4 && busy < .65;
  const workers = mode === "balanced" || resources.availableGB < 2 ? 1
    : mode === "fast" ? Math.min(4, cores)
    : spare ? Math.min(4, cores) : busy < .85 ? Math.min(2, cores) : 1;
  const accelerate = resources.availableGB >= 2 && (mode === "fast" || (mode === "auto" && spare));
  return { translationConcurrency: workers,
    extractionThreads: accelerate ? Math.max(1, cores - 1) : Math.max(1, Math.floor(cores / 2)),
    extractionNice: accelerate ? 5 : 15,
    // MinerU is a fresh CLI process per chunk. Larger chunks amortize model startup,
    // with enough memory; the backend/effort and page offset contract stay the same.
    extractionChunk: mode === "fast" && resources.availableGB >= 8 ? 24
      : accelerate && resources.availableGB >= 4 ? 12 : 6 };
}

const execute = promisify(execFile);
let memorySample: { until: number; value: Promise<number> } | undefined;
async function availableMemoryGB(): Promise<number> {
  if (process.platform !== "darwin") return os.freemem() / 1024 ** 3;
  // macOS keeps reusable RAM in its cache, so os.freemem alone often reports <1GB
  // even with low pressure. Query the OS's available percentage; never allocate memory.
  if (!memorySample || memorySample.until < Date.now()) {
    memorySample = { until: Date.now() + 10_000, value: execute("/usr/bin/memory_pressure", ["-Q"], { timeout: 1000 })
      .then(({ stdout }) => {
        const percent = /System-wide memory free percentage:\s*(\d+)%/.exec(stdout);
        return percent ? os.totalmem() * Math.min(100, Number(percent[1])) / 100 / 1024 ** 3 : os.freemem() / 1024 ** 3;
      }).catch(() => os.freemem() / 1024 ** 3) };
  }
  return memorySample.value;
}

export async function currentProcessing(settings: Settings) {
  const mode = processingMode(settings.processingMode);
  return { mode, ...processingProfile(mode, {
    cores: os.availableParallelism(), availableGB: await availableMemoryGB(), load: os.loadavg()[0],
  }) };
}
