// Bounded scheduling: no Promise.all over the whole paper; stop launching on cancel/error.
export async function runBatches<T>(items: T[], concurrency: () => number,
  run: (item: T, index: number) => Promise<void>, stopped: () => boolean): Promise<void> {
  const running = new Set<Promise<void>>();
  let next = 0;
  let unexpected: unknown;
  let failed = false;
  try {
    while (next < items.length || running.size) {
      const limit = Math.max(1, Math.min(4, Math.floor(concurrency()) || 1));
      while (!failed && !stopped() && next < items.length && running.size < limit) {
        const index = next++;
        let task: Promise<void>;
        task = Promise.resolve().then(() => run(items[index], index))
          .catch((error) => { failed = true; unexpected = error; })
          .finally(() => running.delete(task));
        running.add(task);
      }
      if (!running.size) break;
      await Promise.race(running);
    }
  } finally { await Promise.all(running); }
  if (failed) throw unexpected;
}
