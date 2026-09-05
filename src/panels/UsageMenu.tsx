import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import {
  fetchUsage,
  fetchSpend,
  type AccountUsage,
  type AccountSpend,
  type UsageWindow,
} from "../serverApi";

function fmtCost(c: number): string {
  if (c >= 1000) return `$${(c / 1000).toFixed(1)}K`;
  if (c >= 100) return `$${Math.round(c).toLocaleString()}`;
  return `$${c.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

// Per-day spend over the trailing window as a tiny bar sparkline.
function Trend({ days, color }: { days: { day: string; cost: number }[]; color: string }) {
  if (!days.length) return null;
  const max = Math.max(...days.map((d) => d.cost), 0.01);
  return (
    <div className="usage-trend" title="Daily spend, last 30 days">
      {days.map((d) => (
        <span
          key={d.day}
          className="usage-trend-bar"
          style={{ height: `${Math.max(2, Math.round((d.cost / max) * 100))}%`, background: color }}
          title={`${d.day} · ${fmtCost(d.cost)}`}
        />
      ))}
    </div>
  );
}

const PROVIDER: Record<string, { name: string; color: string }> = {
  claude: { name: "Claude", color: "#D97757" },
  codex: { name: "Codex", color: "#10A37F" },
};

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

// Color always reflects how much is USED (the risk), regardless of what the
// number shows - a nearly-exhausted window is red whether it reads "5% left"
// or "95% used".
function barColor(used: number): string {
  if (used >= 90) return "#e5484d";
  if (used >= 70) return "#d9a441";
  return "#5fb37f";
}

type Mode = "left" | "used";

function Bar({ label, w, mode }: { label: string; w: UsageWindow | null; mode: Mode }) {
  if (!w) return null;
  const used = Math.min(100, Math.max(0, Math.round(w.utilization)));
  const shown = mode === "used" ? used : 100 - used;
  return (
    <div className="usage-bar-row">
      <div className="usage-bar-top">
        <span className="usage-bar-label">{label}</span>
        <span className="usage-bar-pct">{shown}%</span>
        {w.resets_at ? (
          <span className="usage-bar-reset" title={`Resets ${fmtResetAbs(w.resets_at)}`}>
            · {fmtReset(w.resets_at)} <span className="usage-bar-reset-abs">({fmtResetAbs(w.resets_at)})</span>
          </span>
        ) : null}
      </div>
      <div className="usage-bar">
        <div className="usage-bar-fill" style={{ width: `${shown}%`, background: barColor(used) }} />
      </div>
    </div>
  );
}

const MODE_KEY = "pzza.usage.display";
function loadMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "used" ? "used" : "left";
  } catch {
    return "left";
  }
}

// Agent usage for the connected device's Claude / Codex accounts.
export function UsageMenu() {
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<AccountUsage[]>([]);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<Mode>(loadMode);
  const [spend, setSpend] = useState<Record<string, AccountSpend>>({});

  const changeMode = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
  };

  const load = useCallback(() => {
    setLoading(true);
    fetchUsage()
      .then((a) => {
        setAccounts(a);
        setFailed(false);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
    // Spend resolves separately (a slower local scan) so it never holds up usage.
    fetchSpend()
      .then((s) => {
        const map: Record<string, AccountSpend> = {};
        for (const e of s) map[`${e.provider}:${e.label}`] = e;
        setSpend(map);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => load(), [load]);

  return (
    <div className="menu-body usage-menu">
      <div className="usage-head">
        <span className="menu-title">Agent usage</span>
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
          <button className="usage-refresh" onClick={load} title="Refresh" disabled={loading}>
            <RefreshCw size={13} className={loading ? "sw-spin" : ""} />
          </button>
        </div>
      </div>

      {loading && accounts.length === 0 ? (
        <div className="usage-empty">
          <Loader2 size={15} className="sw-spin" /> Loading...
        </div>
      ) : failed ? (
        <div className="usage-empty">
          <AlertTriangle size={15} className="sw-warn" /> Agent unreachable.
        </div>
      ) : accounts.length === 0 ? (
        <div className="usage-empty muted">No Claude or Codex accounts found on this device.</div>
      ) : (
        accounts.map((acc, i) => {
          const p = PROVIDER[acc.provider] ?? { name: acc.label, color: "var(--accent)" };
          return (
            <div className="usage-card" key={i}>
              <div className="usage-card-head">
                <span className="usage-dot" style={{ background: p.color }} />
                <span className="usage-name">{p.name}</span>
                {acc.plan ? <span className="usage-plan">{acc.plan.replace(/_/g, " ")}</span> : null}
                {acc.email ? <span className="usage-email">{acc.email}</span> : null}
              </div>
              {acc.error ? (
                <div className="usage-err">{acc.error}</div>
              ) : (
                <>
                  <Bar label="5h" w={acc.usage?.five_hour ?? null} mode={mode} />
                  <Bar label="Weekly" w={acc.usage?.seven_day ?? null} mode={mode} />
                  {acc.usage?.scoped.map((s) => (
                    <Bar
                      key={s.name}
                      label={s.name}
                      w={{ utilization: s.percent, resets_at: s.resets_at }}
                      mode={mode}
                    />
                  ))}
                  {(() => {
                    const sp = spend[`${acc.provider}:${acc.label}`];
                    if (!sp) return null;
                    const row = (label: string, w: { cost: number; tokens: number }) => (
                      <div className="usage-detail-row">
                        <span className="usage-detail-label">{label}</span>
                        <span className="usage-detail-val">
                          <b>{fmtCost(w.cost)}</b> · {fmtTokens(w.tokens)} tokens
                        </span>
                      </div>
                    );
                    return (
                      <div className="usage-detail" title="Estimated from local transcripts">
                        <div className="usage-detail-row">
                          <span className="usage-detail-label">Usage trend</span>
                          <Trend days={sp.days ?? []} color={p.color} />
                        </div>
                        {row("Today", sp.today)}
                        {row("Yesterday", sp.yesterday)}
                        {row("Last 30 days", sp.window)}
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
