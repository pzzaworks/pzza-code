// One shared reading per device for small agent polls that several features
// ask for on their own timers (output activity, session activity). A caller
// says how old a reading it accepts: a cached one young enough is reused, a
// request already on the way that started recently enough is joined, and only
// otherwise is a new request sent. The shared request has its own timeout, so
// one caller giving up (its signal aborts) never cancels it for the others.

interface Pending<T> { startedAt: number; promise: Promise<T> }
interface Entry<T> { at: number; value?: T; pending?: Pending<T> }

export interface DeviceReadOptions {
  /** The oldest reading (ms since its request started) this caller accepts; 0 always asks the device anew. */
  maxAge: number;
  signal?: AbortSignal;
  /** This machine's clock for the reading; defaults to Date.now(). */
  now?: number;
}

const DEFAULT_KEY = "\u0000default";

// Settles like `promise`, or rejects as soon as `signal` aborts.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createDeviceReadCache<T>(
  fetcher: (host: string | undefined, signal: AbortSignal) => Promise<T>,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): (host: string | undefined, options: DeviceReadOptions) => Promise<T> {
  // Keyed by the exact host argument: `undefined` (the agent's default
  // device) and "" (this machine) can be different devices.
  const entries = new Map<string, Entry<T>>();
  return (host, { maxAge, signal, now = Date.now() }) => {
    const key = host ?? DEFAULT_KEY;
    let entry = entries.get(key);
    if (!entry) {
      entry = { at: 0 };
      entries.set(key, entry);
    }
    const current = entry;
    if (current.value !== undefined && now - current.at < maxAge) return Promise.resolve(current.value);
    let pending = current.pending;
    if (!pending || now - pending.startedAt >= maxAge) {
      const startedAt = now;
      const created: Pending<T> = {
        startedAt,
        promise: fetcher(host, AbortSignal.timeout(timeoutMs)).then((value) => {
          // A slower, older request never replaces a newer reading.
          if (startedAt >= current.at) {
            current.at = startedAt;
            current.value = value;
          }
          return value;
        }, (error: unknown) => {
          // A newer read that failed means the older reading is no longer
          // trusted: the next caller asks the device again.
          if (startedAt >= current.at) {
            current.at = startedAt;
            current.value = undefined;
          }
          throw error;
        }).finally(() => {
          if (current.pending === created) current.pending = undefined;
        }),
      };
      // Every caller may have given up already; a failure then has no reader.
      created.promise.catch(() => {});
      current.pending = created;
      pending = created;
    }
    return untilAborted(pending.promise, signal);
  };
}
