// The desktop app owns the other end of stdin. EOF also arrives after a crash
// or force-quit, without depending on a PID that the OS could reuse.
export function watchDesktopLifetime(shutdown) {
  if (process.env.PZZA_MANAGED_AGENT !== "1") return;
  process.stdin.once("end", shutdown);
  process.stdin.once("error", shutdown);
  process.stdin.resume();
}
