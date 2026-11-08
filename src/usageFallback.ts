import type { AccountSpend, AccountUsage } from "./serverApi";

export interface UsageDevice { host: string; name: string }

export function accountSpendKey(account: Pick<AccountUsage, "provider" | "label" | "sourceHost">): string {
  return JSON.stringify([account.sourceHost ?? "", account.provider, account.label]);
}

export async function loadDeviceSpend(
  devices: UsageDevice[],
  fetch: (host: string) => Promise<AccountSpend[]>,
  update: (spend: Record<string, AccountSpend>) => void,
): Promise<void> {
  const hosts = [...new Set(["", ...devices.map(device => device.host)])];
  const spend: Record<string, AccountSpend> = {};
  let index = 0;
  // Publish each source separately so a slow scan or offline device cannot hide available totals.
  await Promise.all(Array.from({ length: Math.min(3, hosts.length) }, async () => {
    while (index < hosts.length) {
      const host = hosts[index++];
      try {
        const accounts = await fetch(host);
        for (const account of accounts) {
          const value = { ...account, sourceHost: host };
          spend[accountSpendKey(value)] = value;
        }
        update({ ...spend });
      } catch { /* Other devices can still provide their own totals. */ }
    }
  }));
}

// Fresh usage beats a stale (last known) sample, which beats an error card.
const rank = (account: AccountUsage) => account.error || !account.usage ? 0 : account.usage.stale ? 1 : 2;
// Free-plan cards stay out of the panel no matter which device reported them:
// older agents still send them, so the panel filters as well as the server.
// A bare network failure ("fetch failed") says nothing actionable about the
// account, so that card is dropped too instead of showing a red error.
const networkFailure = (account: AccountUsage) => !account.usage && /^(fetch failed|failed to fetch)$/i.test((account.error ?? "").trim());
const shown = (account: AccountUsage) => (account.plan ?? "").trim().toLowerCase() !== "free" && !networkFailure(account);
const identity = (account: AccountUsage) =>
  JSON.stringify([account.provider, account.email?.toLowerCase() || account.keyHint || account.label]);

// Every account signed in on any device gets one card. When several devices
// report the same account, the best-ranked, most recently updated sample wins,
// so a token that lapsed on one device is covered by another that is current.
export function mergeDeviceUsage(local: AccountUsage[], remote: AccountUsage[]): AccountUsage[] {
  const merged = new Map<string, AccountUsage>();
  for (const account of [...local, ...remote].filter(shown)) {
    const key = identity(account);
    const current = merged.get(key);
    if (!current || rank(account) > rank(current) ||
      (rank(account) === rank(current) && (account.usage?.updatedAt ?? 0) > (current.usage?.updatedAt ?? 0))) {
      merged.set(key, account);
    }
  }
  return [...merged.values()];
}

// Query the local agent and every connected device together. `previous` (the
// last published result) keeps its cards visible until each source answers, so
// reopening the panel never blinks an account away mid-refresh.
export async function loadDeviceUsage(
  devices: UsageDevice[],
  fetch: (host: string) => Promise<AccountUsage[]>,
  update: (accounts: AccountUsage[]) => void,
  previous: AccountUsage[] = [],
): Promise<void> {
  const results = new Map<string, AccountUsage[]>();
  const sources = ["", ...new Set(devices.map(device => device.host))];
  const names = new Map(devices.map(device => [device.host, device.name]));
  let pending = sources.length;
  const publish = () => {
    const reported = sources.flatMap(host => results.get(host) ?? []);
    const fresh = mergeDeviceUsage(reported, []);
    if (!pending) return results.size ? update(fresh) : undefined;
    const seen = new Set(fresh.map(identity));
    update([...fresh, ...previous.filter(account => !seen.has(identity(account)))]);
  };
  // Bound SSH concurrency while publishing each healthy source immediately.
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
    while (index < sources.length) {
      const host = sources[index++];
      try {
        const values = await fetch(host);
        results.set(host, host ? values.map(account => ({ ...account, sourceHost: host, sourceName: names.get(host) })) : values);
      } catch { /* Another connected device may provide the same accounts. */ }
      pending--;
      publish();
    }
  }));
  if (!results.size) throw new Error("Usage is unavailable on the connected devices.");
}

// Stable identity of an account card, the same key mergeDeviceUsage dedupes on:
// provider plus email, API key fingerprint or account label.
export function usageAccountKey(account: AccountUsage): string {
  return identity(account);
}

// One limit row of the usage panel (5h, Weekly or a scoped window of one account).
export interface UsageRow {
  accountKey: string;
  provider: AccountUsage["provider"];
  // What identifies the account to a person: email, key fingerprint or label.
  accountName: string;
  windowKey: string;
  window: string;
  used: number;
}

export function usageWindowKey(window: "5h" | "weekly" | { scoped: string }): string {
  return typeof window === "string" ? window : `scoped:${window.scoped}`;
}

// Every limit row the panel shows, in panel order. Error cards carry no usage
// and are skipped; utilization is clamped and rounded exactly like the bars.
export function usageRows(accounts: AccountUsage[]): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const account of accounts) {
    if (account.error || !account.usage) continue;
    const { five_hour, seven_day, scoped } = account.usage;
    const windows = [
      { windowKey: usageWindowKey("5h"), window: "5h", value: five_hour?.utilization },
      { windowKey: usageWindowKey("weekly"), window: "Weekly", value: seven_day?.utilization },
      ...scoped.map(entry => ({ windowKey: usageWindowKey({ scoped: entry.name }), window: entry.name, value: entry.percent })),
    ];
    for (const { windowKey, window, value } of windows) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      rows.push({
        accountKey: identity(account),
        provider: account.provider,
        accountName: account.email || account.keyHint || account.label,
        windowKey,
        window,
        used: Math.min(100, Math.max(0, Math.round(value))),
      });
    }
  }
  return rows;
}

// The most constrained limit: the highest current utilization across every
// row the panel shows; null means nothing to show.
export function usagePeak(accounts: AccountUsage[]): UsageRow | null {
  let peak: UsageRow | null = null;
  for (const row of usageRows(accounts)) if (!peak || row.used > peak.used) peak = row;
  return peak;
}

// A limit row the user pinned as the top bar chip source.
export interface UsagePin {
  accountKey: string;
  windowKey: string;
}

// Validate a stored pin; anything malformed reads as no pin (Auto).
export function parseUsagePin(raw: unknown): UsagePin | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const { accountKey, windowKey } = value;
  if (typeof accountKey !== "string" || typeof windowKey !== "string") return null;
  if (!accountKey || accountKey.length > 600 || !windowKey || windowKey.length > 200) return null;
  return { accountKey, windowKey };
}

// The row the chip shows: the pinned row while it still exists with usage,
// otherwise the automatic peak. A pin whose account or window disappeared
// falls back to Auto without being cleared, so it returns with the account.
export function usageSelection(accounts: AccountUsage[], pin: UsagePin | null): (UsageRow & { pinned: boolean }) | null {
  if (pin) {
    const row = usageRows(accounts).find(entry => entry.accountKey === pin.accountKey && entry.windowKey === pin.windowKey);
    if (row) return { ...row, pinned: true };
  }
  const peak = usagePeak(accounts);
  return peak ? { ...peak, pinned: false } : null;
}
