import { Worker } from "node:worker_threads";

export const SPEND_FRESH_MS = 10 * 60 * 1000;
let spendCache = { at: 0, data: null };
let spendScan = null;
let worker = null;
let pending = null;

function scanSpend(now) {
  if (!worker) {
    const current = new Worker(new URL("./spend-worker.js", import.meta.url));
    worker = current;
    current.on("message", (result) => {
      const request = pending;
      pending = null;
      current.unref();
      if (result.error) request?.reject(new Error(result.error));
      else request?.resolve(result.data);
    });
    const failed = () => {
      if (worker !== current) return;
      worker = null;
      const request = pending;
      pending = null;
      request?.reject(new Error("Spend scan worker stopped"));
    };
    current.on("error", failed);
    current.on("exit", failed);
  }
  worker.ref();
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    worker.postMessage({ now });
  });
}

export function computeSpend({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && spendCache.data && now - spendCache.at < SPEND_FRESH_MS) return Promise.resolve(spendCache.data);
  if (spendScan) return spendScan;
  spendScan = scanSpend(now).then((data) => {
    spendCache = { at: Date.now(), data };
    return data;
  }).finally(() => { spendScan = null; });
  return spendScan;
}
