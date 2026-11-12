// Timers for polling that only matters while the window is visible. While it
// is hidden they do not fire at all (no wake-ups), and work skipped meanwhile
// runs as soon as the window shows again. Polling whose result matters while
// hidden (notifications, forwarding) keeps plain timers.

const hidden = () => document.visibilityState === "hidden";

/**
 * Calls `run` every `interval` ms while the window is visible. Hidden, it
 * stops; shown again it calls `run` at once when a call came due meanwhile
 * (unless `catchUp` is false, for callers that refresh on return themselves),
 * then keeps the interval. Returns a stop.
 */
export function visibleInterval(run: () => void, interval: number, { catchUp = true }: { catchUp?: boolean } = {}): () => void {
  let last = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = () => { last = Date.now(); run(); };
  const start = () => { if (timer === undefined) timer = setInterval(tick, interval); };
  const stop = () => { clearInterval(timer); timer = undefined; };
  const onVisibility = () => {
    if (hidden()) { stop(); return; }
    if (timer !== undefined) return;
    if (Date.now() - last >= interval) {
      if (catchUp) tick();
      else last = Date.now();
    }
    start();
  };
  document.addEventListener("visibilitychange", onVisibility);
  if (!hidden()) start();
  return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); };
}

/**
 * Calls `run` once after `delay` ms, but never while the window is hidden: a
 * call that comes due while hidden waits and runs as soon as it shows again.
 * Returns a cancel.
 */
export function visibleTimeout(run: () => void, delay: number): () => void {
  let waiting = false;
  const onVisibility = () => {
    if (hidden()) return;
    stopWaiting();
    run();
  };
  const stopWaiting = () => {
    if (!waiting) return;
    waiting = false;
    document.removeEventListener("visibilitychange", onVisibility);
  };
  const timer = setTimeout(() => {
    if (!hidden()) { run(); return; }
    waiting = true;
    document.addEventListener("visibilitychange", onVisibility);
  }, delay);
  return () => { clearTimeout(timer); stopWaiting(); };
}
