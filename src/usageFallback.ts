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
const shown = (account: AccountUsage) => (account.plan ?? "").trim().toLowerCase() !== "free";
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
