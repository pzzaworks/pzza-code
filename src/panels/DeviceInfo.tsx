import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { deviceHost, type Device } from "../devices";
import { fetchDeviceInfo, type DeviceInfo as DeviceInfoResult } from "../serverApi";
import { DeviceIcon } from "../ui/DeviceIcon";

function bytes(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "Unavailable";
  if (value === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function uptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "Unavailable";
  const minutes = Math.floor(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return `${days ? `${days}d ` : ""}${hours}h ${minutes % 60}m`;
}

export function DeviceInfo({ device }: { device: Device }) {
  const host = deviceHost(device);
  const [result, setResult] = useState<DeviceInfoResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const load = async (fresh: boolean) => {
      setLoading(true);
      try {
        const next = await fetchDeviceInfo(host, controller.signal, fresh);
        if (disposed) return;
        setResult(next);
        setError(null);
      } catch (cause) {
        if (disposed) return;
        setResult(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!disposed) {
          setLoading(false);
          timer = setTimeout(() => void load(false), 10000);
        }
      }
    };
    void load(refresh > 0);
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [host, refresh]);

  const info = result?.info;
  const reachable = result?.health === "reachable";
  const available = info?.memory.availableBytes ?? info?.memory.freeBytes ?? null;
  const memoryTotal = info?.memory.totalBytes ?? null;
  const usedRatio = available !== null && memoryTotal !== null && memoryTotal > 0
    ? Math.max(0, Math.min(100, (1 - available / memoryTotal) * 100)) : null;
  const status = error ? "Unavailable" : !result ? "Checking connection…" : reachable ? "Reachable" : "Unreachable";

  return (
    <section className="device-info" aria-label={`${device.name} device details`} aria-busy={loading}>
      <div className="device-info-heading">
        <span className="device-info-os"><DeviceIcon device={device} size={21} />
          <span><strong>{info?.osName || "Operating system"}</strong><span>{info?.osVersion || (info ? "Version unavailable" : "Details unavailable")}</span></span>
        </span>
        <button type="button" className="usage-refresh" title="Refresh device details" aria-label="Refresh device details" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw size={14} className={loading ? "sw-spin" : ""} />
        </button>
      </div>
      <div className="device-info-health" role="status">
        <span className={`device-info-status ${reachable ? "device-info-reachable" : ""}`}>{status}</span>
        {result ? <span>{result.connection === "local" ? "Local" : "SSH"} probe round trip · {result.connectionMs.toFixed(0)} ms</span> : null}
      </div>
      {error || result?.error ? <p className="device-info-error">{error || result?.error}</p> : null}
      <dl className="device-info-grid">
        <div className="device-info-item"><dt>Hostname</dt><dd>{info?.hostname || "Unavailable"}</dd></div>
        <div className="device-info-item"><dt>Uptime</dt><dd>{info ? uptime(info.uptimeSeconds) : "Unavailable"}</dd></div>
        <div className="device-info-item device-info-wide"><dt>IP addresses</dt><dd className="device-info-addresses">
          {info?.addresses.length ? info.addresses.map((address) => <span key={`${address.interface}:${address.address}`} className="device-info-address"><code>{address.address}</code><small>{address.interface} · {address.family}</small></span>) : "Unavailable"}
        </dd></div>
        <div className="device-info-item"><dt>CPU</dt><dd>{info ? `${info.cpu.logicalCores} logical cores` : "Unavailable"}<small>{info?.cpu.model || "Model unavailable"}</small></dd></div>
        <div className="device-info-item"><dt>Load average</dt><dd>{info?.cpu.loadAverage ? info.cpu.loadAverage.map((value) => value.toFixed(2)).join(" / ") : "Unavailable"}<small>1 / 5 / 15 minutes</small></dd></div>
        <div className="device-info-item device-info-wide"><dt>Memory</dt><dd>
          {memoryTotal !== null ? `${bytes(available)} ${info?.memory.availableBytes !== null ? "available" : "free"} / ${bytes(memoryTotal)} total` : "Unavailable"}
          {usedRatio !== null ? <span className="device-info-memory" role="meter" aria-label={info?.memory.availableBytes !== null ? "Memory in use" : "Memory not free, including cache"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usedRatio)}><span style={{ width: `${usedRatio}%` }} /></span> : null}
        </dd></div>
        <div className="device-info-item"><dt>Architecture</dt><dd>{info?.arch || "Unavailable"}</dd></div>
        <div className="device-info-item"><dt>Kernel</dt><dd>{info?.kernelVersion || "Unavailable"}</dd></div>
      </dl>
      <p className="device-info-updated">{result ? `Checked ${new Date(result.checkedAt).toLocaleTimeString()}` : "Waiting for a device response"} · {loading ? "Updating…" : "Updates every 10 seconds"}</p>
    </section>
  );
}
