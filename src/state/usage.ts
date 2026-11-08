import { create } from "zustand";
import { deviceHost, type Device } from "../devices";
import { fetchSpend, fetchUsage, type AccountSpend, type AccountUsage } from "../serverApi";
import { loadDeviceSpend, loadDeviceUsage, parseUsagePin, type UsageDevice, type UsagePin } from "../usageFallback";

export type UsageMode = "left" | "used";

// The agents cache usage for five minutes (USAGE_FRESH_MS in server/lib/usage.js)
// because the provider endpoints rate limit harder polling, so the top bar
// refreshes on the same cadence and never faster.
export const USAGE_POLL_MS = 5 * 60 * 1000;

const MODE_KEY = "pzza.usage.display";
function loadMode(): UsageMode {
  try {
    return localStorage.getItem(MODE_KEY) === "used" ? "used" : "left";
  } catch {
    return "left";
  }
}

// The limit row pinned as the top bar chip source (null = Auto, the peak).
const PIN_KEY = "pzza.usage.chipPin";
function loadPin(): UsagePin | null {
  try {
    return parseUsagePin(JSON.parse(localStorage.getItem(PIN_KEY) || "null"));
  } catch {
    return null;
  }
}

// Whether the top bar shows the usage percentage and meter beside the gauge
// icon; off by default, so the trigger is just the icon.
const VISIBLE_KEY = "pzza.usage.chipVisible";
function loadVisible(): boolean {
  try {
    return localStorage.getItem(VISIBLE_KEY) === "1";
  } catch {
    return false;
  }
}

interface UsageState {
  accounts: AccountUsage[];
  spend: Record<string, AccountSpend>;
  // True until the first load settles, so the panel never flashes an empty state.
  loading: boolean;
  failed: boolean;
  mode: UsageMode;
  pin: UsagePin | null;
  showInTopBar: boolean;
}

// Agent usage shared by the usage panel and its top bar chip. The last
// published cards outlive the panel, so reopening it shows every account
// immediately while the devices are queried again.
export const useUsage = create<UsageState>(() => ({
  accounts: [],
  spend: {},
  loading: true,
  failed: false,
  mode: loadMode(),
  pin: loadPin(),
  showInTopBar: loadVisible(),
}));

export function setUsagePin(pin: UsagePin | null): void {
  try {
    if (pin) localStorage.setItem(PIN_KEY, JSON.stringify(pin));
    else localStorage.removeItem(PIN_KEY);
  } catch {
    /* ignore */
  }
  useUsage.setState({ pin });
}

export function setUsageChipVisible(showInTopBar: boolean): void {
  try {
    localStorage.setItem(VISIBLE_KEY, showInTopBar ? "1" : "0");
  } catch {
    /* ignore */
  }
  useUsage.setState({ showInTopBar });
}

export function setUsageMode(mode: UsageMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* ignore */
  }
  useUsage.setState({ mode });
}

let usageRequest = 0;
let spendRequest = 0;
let inFlight = 0;
let lastStarted = 0;

function usageSources(devices: Device[]): UsageDevice[] {
  return devices.filter(device => deviceHost(device)).map(device => ({ host: deviceHost(device), name: device.name }));
}

// Query the local agent and every connected device. Only the newest request
// publishes, so a slow older response never overwrites a newer one. Spend
// (transcript scans) is only requested by the panel, which displays it.
export function refreshUsage(devices: Device[], { fresh = false, spend = false }: { fresh?: boolean; spend?: boolean } = {}): Promise<void> {
  const current = ++usageRequest;
  inFlight++;
  lastStarted = Date.now();
  useUsage.setState({ loading: true });
  const sources = usageSources(devices);
  if (spend) {
    const spendCurrent = ++spendRequest;
    // Device transcript scans resolve separately so they never hold up usage.
    void loadDeviceSpend(sources, host => fetchSpend(fresh, host), values => {
      if (spendRequest === spendCurrent) useUsage.setState({ spend: values });
    });
  }
  return loadDeviceUsage(sources, host => fetchUsage(fresh, host), accounts => {
    if (usageRequest !== current) return;
    useUsage.setState(accounts.some(account => account.usage && !account.error)
      ? { accounts, failed: false, loading: false }
      : { accounts, failed: false });
  }, useUsage.getState().accounts)
    .catch(() => { if (usageRequest === current) useUsage.setState({ failed: true }); })
    .finally(() => {
      inFlight--;
      if (usageRequest === current) useUsage.setState({ loading: false });
    });
}

// Background refresh for the top bar chip while the panel is closed: runs
// immediately, then every USAGE_POLL_MS, only while the window is visible and
// no other usage request (for example the open panel's) is already running.
// Returning to a visible window refreshes once if the last sample is due.
export function startUsagePolling(devices: () => Device[]): () => void {
  const tick = () => {
    if (document.visibilityState !== "visible" || inFlight > 0) return;
    void refreshUsage(devices());
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible" && Date.now() - lastStarted >= USAGE_POLL_MS) tick();
  };
  tick();
  const timer = window.setInterval(tick, USAGE_POLL_MS);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
