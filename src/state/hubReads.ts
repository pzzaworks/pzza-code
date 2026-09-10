// Read caches hold only in-memory snapshots. Mutations and deployment checks never use them.
export function createReadCache<T>(maxEntries: number, ttlMs: number) {
  const cache = new Map<string, { value: T; expires: number }>();
  const pending = new Map<string, Promise<T>>();
  let generation = 0;
  return {
    peek(key: string): T | undefined { return cache.get(key)?.value; },
    clear() { generation++; cache.clear(); pending.clear(); },
    read(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
      const inflight = pending.get(key);
      if (inflight) return inflight;
      const found = cache.get(key);
      if (!fresh && found && found.expires > Date.now()) return Promise.resolve(found.value);
      const started = generation;
      const operation = load().then(value => {
        if (started === generation) {
          cache.delete(key);
          cache.set(key, { value, expires: Date.now() + ttlMs });
          while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
        }
        return value;
      }).finally(() => { if (pending.get(key) === operation) pending.delete(key); });
      pending.set(key, operation);
      return operation;
    },
  };
}

/** Each worker publishes independently; a slow device never withholds completed peers. */
export async function readIncrementally<T, R>(items: readonly T[], read: (item: T) => Promise<R>, publish: (result: R) => void, concurrency = 4): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      publish(await read(items[index]));
    }
  }));
}
