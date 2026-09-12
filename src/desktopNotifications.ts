import { HAS_TAURI } from "./tauriEnv";

export async function requestDesktopAlerts(): Promise<boolean> {
  if (HAS_TAURI) {
    const native = await import("@tauri-apps/plugin-notification");
    return await native.isPermissionGranted() || await native.requestPermission() === "granted";
  }
  if (typeof Notification === "undefined") throw new Error("System notifications are unavailable in this browser. Activity history still works.");
  return Notification.permission === "granted" || await Notification.requestPermission() === "granted";
}

export async function deliverDesktopAlert(alert: { category: string; title: string; body: string }, stillAllowed: () => boolean): Promise<void> {
  const options = { title: alert.title || "PzzaCode", body: alert.body, tag: alert.category };
  if (HAS_TAURI) {
    const native = await import("@tauri-apps/plugin-notification");
    if (await native.isPermissionGranted() && stillAllowed()) native.sendNotification(options);
    return;
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || !stillAllowed()) return;
  const shown = new Notification(options.title, options);
  shown.onclick = () => { window.focus(); shown.close(); };
}
