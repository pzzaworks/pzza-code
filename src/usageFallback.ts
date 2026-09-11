import type { AccountUsage } from "./serverApi";

export interface UsageDevice { host: string; name: string }
const providers = ["claude", "codex", "opencode"] as const;
const usable = (account: AccountUsage) => Boolean(account.usage && !account.error && !account.usage.stale);

export function mergeDeviceUsage(local: AccountUsage[], remote: AccountUsage[]): AccountUsage[] {
  const result = local.map(account => {
    if (usable(account)) return account;
    return remote.find(candidate => candidate.provider === account.provider && usable(candidate) &&
      (account.email ? candidate.email?.toLowerCase() === account.email.toLowerCase() : candidate.label === account.label)) ?? account;
  });
  for (const provider of providers) {
    const missing = !local.some(account => account.provider === provider && usable(account));
    if (!missing) continue;
    const seen = new Set<string>();
    const replacements = remote.filter(account => {
      if (account.provider !== provider || !usable(account)) return false;
      const key = account.email?.toLowerCase() || account.label;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (replacements.length) {
      for (let index = result.length - 1; index >= 0; index--) if (result[index].provider === provider) result.splice(index, 1);
      result.push(...replacements);
    }
  }
  return result;
}

export async function loadDeviceUsage(
  devices: UsageDevice[],
  fetch: (host: string) => Promise<AccountUsage[]>,
  update: (accounts: AccountUsage[]) => void,
): Promise<void> {
  let local: AccountUsage[] = [];
  const remote = new Map<string, AccountUsage[]>();
  let localResolved = false;
  let successful = false;
  let remoteWork: Promise<void> | undefined;
  const publish = () => update(mergeDeviceUsage(local, devices.flatMap(device => remote.get(device.host) ?? [])));
  const startRemote = () => remoteWork ??= (async () => {
    // Bound SSH concurrency while publishing each healthy device immediately.
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(3, devices.length) }, async () => {
      while (index < devices.length) {
        const device = devices[index++];
        try {
          const values = await fetch(device.host);
          successful = true;
          remote.set(device.host, values.map(account => ({ ...account, sourceHost: device.host, sourceName: device.name })));
          publish();
        } catch { /* Another connected device may provide the missing account. */ }
      }
    }));
  })();
  const timer = setTimeout(() => { if (!localResolved) void startRemote(); }, 300);
  try {
    local = await fetch("");
    successful = true;
    localResolved = true;
    publish();
    if (local.some(account => !usable(account)) || providers.some(provider => !local.some(account => account.provider === provider && usable(account)))) void startRemote();
  } catch { localResolved = true; void startRemote(); }
  finally { clearTimeout(timer); }
  await remoteWork;
  if (!successful) throw new Error("Usage is unavailable on the connected devices.");
}
