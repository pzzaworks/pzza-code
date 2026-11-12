import { useStore } from "../state/store";
import { deviceHost } from "../devices";
import { accountSpendKey, usageAccountKey, usageSelection, usageWindowKey } from "../usageFallback";
import { Switch } from "../ui/Switch";
import { useDelayedLoading } from "../ui/useDelayedLoading";
import { AsyncButton } from "../ui/AsyncButton";
import { Dropdown } from "../ui/Dropdown";
import { AgentIcon } from "../icons/AgentIcon";
import { sessionAgent } from "../../server/lib/session-agents.js";
import { estimateLabel, fmtCost, fmtTokens, UsageSpend } from "./UsageSpend";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronRight, Gauge, Loader2, RefreshCw } from "lucide-react";
import { fixUsage, type AccountSpend, type AccountUsage, type UsageBalance, type UsageWindow } from "../serverApi";
import { refreshUsage, setUsageChipVisible, setUsageMode, setUsagePin, startUsagePolling, useUsage, type UsageMode } from "../state/usage";

// The names and brand tints the panel has always used for these agents; every
// other agent shows its catalog name, in the text color with an accent trend.
const BRANDS: Partial<Record<string, { name: string; color: string }>> = {
  claude: { name: "Claude", color: "#D97757" },
  codex: { name: "Codex", color: "#10A37F" },
  opencode: { name: "OpenCode", color: "#94A3B8" },
};

function agentBrand(provider: string, fallback: string): { name: string; color: string; trend: string } {
  const brand = Object.hasOwn(BRANDS, provider) ? BRANDS[provider] : undefined;
  return { name: brand?.name ?? sessionAgent(provider)?.label ?? fallback, color: brand?.color ?? "var(--text)", trend: brand?.color ?? "var(--accent)" };
}

// Agents whose cards come from a signed-in account. Their spend shows inside
// that card; an account the panel hides (a free plan, lapsed credentials)
// keeps its spend hidden too.
const ACCOUNT_AGENTS = new Set(["claude", "codex"]);

function fmtReset(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// The actual reset date/clock time. Same day shows just the time; a later day
// prefixes the weekday + date, so a weekly window reads e.g. "Sun 9 · 21:40".
function fmtResetAbs(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  const day = d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  return `${day} · ${time}`;
}

// Compact reset time for a row's single label line: "05:59" today, otherwise
// "Thu 05:59". The full date stays in the row tooltip.
function fmtResetShort(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

// Color always reflects how much is USED (the risk), regardless of what the
// number shows - a nearly-exhausted window is red whether it reads "5% left"
// or "95% used".
function barColor(used: number): string {
  if (used >= 90) return "#e5484d";
  if (used >= 70) return "#d9a441";
  return "#5fb37f";
}

type Mode = UsageMode;

// The row the top bar shows: pinned by the user, or picked automatically (the
// highest usage) while nothing is pinned. Exactly one row is selected either way.
interface BarPin { pinned: boolean; auto: boolean; account: string; onToggle: () => void }

function Bar({ label, w, mode, pin }: { label: string; w: UsageWindow | null; mode: Mode; pin?: BarPin }) {
  if (!w) return null;
  const used = Math.min(100, Math.max(0, Math.round(w.utilization)));
  const shown = mode === "used" ? used : 100 - used;
  // One line only: the text is a single ellipsized run, so the least important
  // tail (the parenthesized reset date) is cut first; the tooltip has it all.
  const full = `${label} ${shown}% ${mode}${w.resets_at ? ` · resets in ${fmtReset(w.resets_at)} (${fmtResetAbs(w.resets_at)})` : ""}`;
  return (
    <div className="usage-bar-row">
      <div className="usage-bar-top">
        <span className="usage-bar-text" title={full}>
          <span className="usage-bar-label">{label}</span>
          <span className="usage-bar-pct">{shown}%</span>
          {w.resets_at ? (
            <span className="usage-bar-reset">
              · {fmtReset(w.resets_at)} <span className="usage-bar-reset-abs">{fmtResetShort(w.resets_at)}</span>
            </span>
          ) : null}
        </span>
        {pin ? (
          <button
            type="button"
            className={`usage-pin ${pin.pinned ? "on" : ""} ${pin.auto ? "is-auto" : ""}`}
            aria-pressed={pin.pinned}
            aria-label={`Show ${pin.account} ${label} in the menu bar`}
            title={pin.pinned ? "Shown in the menu bar. Click to go back to Auto" : pin.auto ? "Shown in the menu bar automatically (highest usage). Click to keep showing this one" : "Show this limit in the menu bar"}
            onClick={pin.onToggle}
          >
            {pin.auto ? <span className="usage-pin-auto">Auto</span> : null}
            <span className="usage-radio" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="usage-bar">
        <div className="usage-bar-fill" style={{ width: `${shown}%`, background: barColor(used) }} />
      </div>
    </div>
  );
}

// A prepaid balance (credits or dollars left): an amount, not a percentage bar.
function Balance({ balance }: { balance: UsageBalance }) {
  const value = balance.unit === "usd" ? fmtCost(balance.amount) : `${Math.round(balance.amount).toLocaleString()} credits`;
  return (
    <div className="usage-bar-row usage-balance">
      <span className="usage-bar-label">{balance.name}</span>
      <span className="usage-balance-val">{value} left</span>
    </div>
  );
}

// Agents with local usage but no limits card, one compact row each that opens
// into the same spend details a card shows.
function OtherAgents({ entries, deviceName }: { entries: AccountSpend[]; deviceName: (host: string) => string | undefined }) {
  if (!entries.length) return null;
  return (
    <section className="usage-others" aria-label="Other agents, last 30 days">
      <div className="usage-section-title">
        <span>Other agents</span>
        <span className="usage-section-note">Last 30 days</span>
      </div>
      {entries.map((sp) => {
        const brand = agentBrand(sp.provider, sp.label);
        const device = sp.sourceHost ? deviceName(sp.sourceHost) ?? sp.sourceHost : undefined;
        const tokens = sp.tokensTracked !== false ? ` · ${fmtTokens(sp.window.tokens)} tokens` : "";
        return (
          <div className="usage-agent" key={`${sp.sourceHost ?? ""}\n${sp.provider}\n${sp.label}`} data-agent={sp.provider}>
            <UsageSpend
              spend={sp}
              color={brand.trend}
              agentName={brand.name}
              summary={
                <span className="usage-agent-head" title={`${brand.name}${device ? ` on ${device}` : ""}: ${estimateLabel(sp.window)}${tokens} in the last 30 days`}>
                  <ChevronRight size={12} className="usage-agent-chevron" aria-hidden="true" />
                  <span className="usage-brand" style={{ color: brand.color }}><AgentIcon id={sp.provider} size={14} /></span>
                  <span className="usage-agent-name">{brand.name}</span>
                  {device ? <span className="usage-plan">{device}</span> : null}
                  <span className="usage-agent-total"><b>{estimateLabel(sp.window)}</b></span>
                </span>
              }
            />
          </div>
        );
      })}
    </section>
  );
}

// Agent usage for every connected device's agent accounts and local usage.
// Results live in the shared usage store, which the top bar chip reads too.
export function UsageMenu() {
  const devices = useStore(store => store.activeDevices);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  const loading = useUsage(state => state.loading);
  const accounts = useUsage(state => state.accounts);
  const failed = useUsage(state => state.failed);
  const mode = useUsage(state => state.mode);
  const spend = useUsage(state => state.spend);
  // Spend of agents without a card here: local usage of agents that have no
  // limits to show, in the order the devices reported them.
  const others = useMemo(() => {
    const carded = new Set(accounts.map(accountSpendKey));
    return Object.values(spend).filter(sp => !ACCOUNT_AGENTS.has(sp.provider) && !carded.has(accountSpendKey(sp)));
  }, [accounts, spend]);
  const deviceName = useCallback((host: string) => devices.find(device => deviceHost(device) === host)?.name, [devices]);
  const [spinning, setSpinning] = useState(false);
  const showSpinner = useDelayedLoading(loading);
  useEffect(() => { if (showSpinner) setSpinning(true); }, [showSpinner]);
  const [fixing, setFixing] = useState<number | null>(null);

  const changeMode = (m: Mode) => setUsageMode(m);

  // Chip source: a pinned row while it still exists, otherwise Auto (the peak).
  const pin = useUsage(state => state.pin);
  const showInTopBar = useUsage(state => state.showInTopBar);
  const selection = useMemo(() => usageSelection(accounts, pin), [accounts, pin]);
  const pinFor = (account: AccountUsage, windowKey: string): BarPin => {
    const accountKey = usageAccountKey(account);
    const shown = !!selection && selection.accountKey === accountKey && selection.windowKey === windowKey;
    const pinned = shown && !!selection?.pinned;
    return {
      pinned,
      auto: shown && !selection?.pinned,
      account: account.email || account.keyHint || account.label,
      onToggle: () => setUsagePin(pinned ? null : { accountKey, windowKey }),
    };
  };

  const load = useCallback((fresh = false) => {
    const current = ++request.current;
    void refreshUsage(devices, { fresh, spend: true }).finally(() => {
      if (request.current !== current) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setSpinning(false);
    });
  }, [devices]);
  useEffect(() => load(false), [load]);

  // One-click repair for local Claude token errors: runs the CLI once (the
  // documented manual fix) and reloads usage. Remote accounts use the header
  // refresh instead - this endpoint only repairs the local device.
  const fix = useCallback(async (index: number, provider: string) => {
    setFixing(index);
    try {
      await fixUsage(provider);
      load(true);
    } catch {
      load(true);
    } finally {
      setFixing(current => (current === index ? null : current));
    }
  }, [load]);

  return (
    <div className="menu-body usage-menu">
      <div className="usage-head menu-head">
        <span className="menu-head-title">Agent usage</span>
        <div className="usage-tools">
          <div className="usage-seg" role="group" title="Show remaining or used">
            <button
              className={mode === "left" ? "on" : ""}
              onClick={() => changeMode("left")}
            >
              Left
            </button>
            <button
              className={mode === "used" ? "on" : ""}
              onClick={() => changeMode("used")}
            >
              Used
            </button>
          </div>
          <button className="usage-refresh" onClick={() => load(true)} title="Refresh" disabled={loading || spinning} aria-busy={loading}>
            <RefreshCw size={13} className={spinning ? "sw-spin" : ""} onAnimationIteration={() => { if (!loading) setSpinning(false); }} />
          </button>
        </div>
      </div>
      {loading && accounts.length === 0 && others.length === 0 ? (
        <div className="usage-empty">
          {showSpinner ? <Loader2 size={15} className="sw-spin" /> : null} Loading...
        </div>
      ) : failed ? (
        <div className="usage-empty">
          <AlertTriangle size={15} className="sw-warn" /> Agent unreachable.
        </div>
      ) : accounts.length === 0 && others.length === 0 ? (
        <div className="usage-empty muted">No agent accounts or local agent usage found on available devices.</div>
      ) : (
        <>
        {accounts.map((acc, i) => {
          const p = agentBrand(acc.provider, acc.label);
          return (
            <div className="usage-card" key={i}>
              <div className="usage-card-head" title={[p.name, acc.plan?.replace(/_/g, " "), acc.email || acc.keyHint, acc.sourceName].filter(Boolean).join(" · ")}>
                <span className="usage-brand" style={{ color: p.color }}>
                  <AgentIcon id={acc.provider} size={15} />
                </span>
                <span className="usage-name">{p.name}</span>
                {acc.plan ? <span className="usage-plan">{acc.plan.replace(/_/g, " ")}</span> : null}
                {acc.email ? (
                  <span className="usage-email">{acc.email}</span>
                ) : acc.keyHint ? (
                  <span className="usage-email usage-key" title="API key fingerprint">{acc.keyHint}</span>
                ) : null}
                {acc.sourceName ? <span className="usage-plan" title={`Usage from ${acc.sourceHost}`}>{acc.sourceName}</span> : null}
              </div>
              {acc.error ? (
                <>
                  <div className="usage-err">{acc.error}</div>
                  {acc.provider === "claude" && !acc.sourceHost && /token/i.test(acc.error) ? (
                    <AsyncButton className="btn btn-sm" loading={fixing === i} disabled={fixing !== null} onClick={() => void fix(i, acc.provider)}>
                      Run Claude to refresh
                    </AsyncButton>
                  ) : null}
                </>
              ) : (
                <>
                  {acc.usage?.stale && (
                    <div className="muted usage-stale" role="status">
                      {acc.usage.source === "session"
                        ? `Usage service unreachable. Showing the limits ${p.name} recorded${acc.usage.updatedAt ? ` at ${new Date(acc.usage.updatedAt).toLocaleTimeString()}` : ""}.`
                        : `Showing last successful usage${acc.usage.updatedAt ? ` from ${new Date(acc.usage.updatedAt).toLocaleTimeString()}` : ""}.`}
                      {acc.usage.retryAt ? ` Retrying after ${new Date(acc.usage.retryAt).toLocaleTimeString()}.` : ""}
                    </div>
                  )}
                  <Bar label="5h" w={acc.usage?.five_hour ?? null} mode={mode} pin={pinFor(acc, usageWindowKey("5h"))} />
                  <Bar label="Weekly" w={acc.usage?.seven_day ?? null} mode={mode} pin={pinFor(acc, usageWindowKey("weekly"))} />
                  {acc.usage?.scoped.map((s) => (
                    <Bar
                      key={s.name}
                      label={s.name}
                      w={{ utilization: s.percent, resets_at: s.resets_at }}
                      mode={mode}
                      pin={pinFor(acc, usageWindowKey({ scoped: s.name }))}
                    />
                  ))}
                  {acc.usage?.balances?.map((balance) => <Balance key={balance.name} balance={balance} />)}
                  {(() => {
                    const sp = spend[accountSpendKey(acc)];
                    return sp ? <UsageSpend spend={sp} color={p.trend} agentName={p.name} /> : null;
                  })()}
                </>
              )}
            </div>
          );
        })}
        <OtherAgents entries={others} deviceName={deviceName} />
        </>
      )}
      <div className="usage-footer">
        <span>Show percentage</span>
        <Switch small on={showInTopBar} onToggle={() => setUsageChipVisible(!showInTopBar)} title="Show percentage" />
      </div>
    </div>
  );
}

// Top bar trigger for the usage panel. By default it is just the gauge icon.
// With "Show percentage" on, it also shows one limit row (meter plus
// percentage in the panel's Left/Used mode): the row pinned in the panel, or
// (Auto) the most constrained current limit across every account. The
// background refresh only runs while that info is shown.
export function UsageTool() {
  const hostKey = useStore(store => store.activeDevices.map(device => deviceHost(device)).join("\n"));
  const showInTopBar = useUsage(state => state.showInTopBar);
  useEffect(() => showInTopBar ? startUsagePolling(() => useStore.getState().activeDevices) : undefined, [hostKey, showInTopBar]);
  const accounts = useUsage(state => state.accounts);
  const mode = useUsage(state => state.mode);
  const pin = useUsage(state => state.pin);
  const row = useMemo(() => usageSelection(accounts, pin), [accounts, pin]);
  const shown = row ? (mode === "used" ? row.used : 100 - row.used) : 0;
  const visible = showInTopBar && row;
  const summary = row ? `Agent usage (${row.pinned ? "pinned" : "Auto"}): ${row.accountName} ${row.window} ${shown}% ${mode === "used" ? "used" : "left"}` : undefined;
  return (
    <Dropdown
      icon={Gauge}
      title="Agent usage"
      controlId="usage"
      width={320}
      tourId="usage"
      badgeLabel={visible ? summary : undefined}
      badge={visible ? (
        <span className="usage-chip">
          <span className="usage-chip-meter">
            <span className="usage-chip-fill" style={{ width: `${shown}%`, background: barColor(row.used) }} />
          </span>
          <span className="usage-chip-pct">{shown}%</span>
        </span>
      ) : null}
    >
      <UsageMenu />
    </Dropdown>
  );
}
