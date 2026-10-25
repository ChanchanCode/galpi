import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Publish only a complete PDF, without replacing an existing download with the same name.
export async function saveNewPdf(directory: string, name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const pending = path.join(directory, `.galpi-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(pending, bytes, { flag: "wx" });
    for (let n = 0; n < 10000; n++) {
      signal?.throwIfAborted();
      const destination = path.join(directory, n ? `${name.slice(0, -4)} (${n}).pdf` : name);
      try {
        await fs.link(pending, destination);
        if (signal?.aborted) { await fs.rm(destination); signal.throwIfAborted(); }
        return destination;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new Error("같은 이름의 PDF가 너무 많습니다.");
  } finally { await fs.rm(pending, { force: true }); }
}
