import { useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import { siApple, siFreebsd, siLinux } from "simple-icons";
import { deviceHost, type Device, type DeviceOs } from "../devices";
import { fetchDeviceOs } from "../serverApi";

const cache = new Map<string, { os: DeviceOs; expires: number }>();
const pending = new Map<string, Promise<DeviceOs>>();
const queue: Array<() => void> = [];
let active = 0;

function detect(host: string): Promise<DeviceOs> {
  const saved = cache.get(host);
  if (saved && saved.expires > Date.now()) return Promise.resolve(saved.os);
  const running = pending.get(host);
  if (running) return running;
  const result = new Promise<DeviceOs>((resolve) => {
    const start = () => {
      active++;
      void fetchDeviceOs(host).catch((): DeviceOs => "unknown").then((os) => {
        if (cache.size >= 256) cache.delete(cache.keys().next().value ?? "");
        cache.set(host, { os, expires: Date.now() + (os === "unknown" ? 30000 : 3600000) });
        pending.delete(host);
        active--;
        queue.shift()?.();
        resolve(os);
      });
    };
    if (active < 4) start();
    else queue.push(start);
  });
  pending.set(host, result);
  return result;
}

export function DeviceIcon({ device, host = "", size = 14 }: { device?: Device; host?: string; size?: number }) {
  const target = device ? deviceHost(device) : host;
  const [detected, setDetected] = useState<{ host: string; os: DeviceOs }>();
  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      void detect(target).then((os) => {
        if (disposed) return;
        setDetected({ host: target, os });
        retry = setTimeout(refresh, os === "unknown" ? 30000 : 3600000);
      });
    };
    refresh();
    return () => { disposed = true; clearTimeout(retry); };
  }, [target]);
  const os = detected?.host === target ? detected.os : cache.get(target)?.os ?? "unknown";
  const title = { macos: "macOS", linux: "Linux", windows: "Windows", freebsd: "FreeBSD", unknown: "Operating system unavailable" }[os];
  const icon = os === "macos" ? siApple : os === "linux" ? siLinux : os === "freebsd" ? siFreebsd : null;
  if (!icon && os !== "windows") return <Monitor size={size} className="device-os-icon" aria-label={title} />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className="device-os-icon" role="img" aria-label={title}>
      <title>{title}</title>
      <path d={icon?.path ?? "M2 2h9v9H2zm11 0h9v9h-9zM2 13h9v9H2zm11 0h9v9h-9z"} />
    </svg>
  );
}
