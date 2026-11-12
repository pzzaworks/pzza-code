import { Info } from "lucide-react";
import type { ReactNode } from "react";
import type { AccountSpend, SpendDay, SpendWindow } from "../serverApi";

export function fmtCost(c: number): string {
  if (c >= 1000) return `$${(c / 1000).toFixed(1)}K`;
  if (c >= 100) return `$${Math.round(c).toLocaleString()}`;
  return `$${c.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

export function estimateLabel(w: SpendWindow): string {
  if (w.cost !== null) return fmtCost(w.cost);
  return w.pricedCost > 0 ? `${fmtCost(w.pricedCost)}+ (partial)` : "Unavailable";
}

function estimateDescription(w: SpendWindow, recorded: boolean): string {
  if (w.cost !== null) return estimateLabel(w);
  const reason = recorded ? "have no cost recorded by the agent" : "have no verified rate";
  return `${estimateLabel(w)}: ${fmtTokens(w.unpricedTokens)} tokens ${reason} (${w.unpricedModels.join(", ")}).`;
}

// Cost the agent stored itself (OpenCode, Pi, goose, ...) rather than an
// estimate from token rates.
export function recordedSpend(spend: Pick<AccountSpend, "pricingBasis">): boolean {
  return spend.pricingBasis === "agent-recorded";
}

function Trend({ days, color, byCost, recorded }: { days: SpendDay[]; color: string; byCost: boolean; recorded: boolean }) {
  if (!days.length) return null;
  // Token counts remain measurable even when a model's price is unavailable.
  // A missing rate must not turn a day into an invented full-height spend bar.
  // Agents that record cost but no tokens are drawn by their recorded cost.
  const value = (day: SpendDay) => (byCost ? day.pricedCost : day.tokens);
  const max = Math.max(...days.map(value), byCost ? 0.000001 : 1);
  const label = byCost
    ? "Daily recorded cost, last 30 days. This agent records cost but no token counts."
    : "Daily token usage, last 30 days. Bar height represents tokens, not cost; pricing availability does not affect the bars.";
  return (
    <div className="usage-trend" role="img" aria-label={label}>
      {days.map((day) => (
        <span
          key={day.day}
          className="usage-trend-bar"
          style={{ height: `${value(day) > 0 ? Math.max(2, Math.round((value(day) / max) * 100)) : 0}%`, background: color }}
          title={byCost ? `${day.day} · ${estimateLabel(day)}` : `${day.day} · ${fmtTokens(day.tokens)} tokens · ${estimateDescription(day, recorded)}`}
        />
      ))}
    </div>
  );
}

// Spend details of one agent. `summary` replaces the "More" toggle text, so an
// agent without a limits card shows as one compact, expandable row.
export function UsageSpend({ spend, color, summary, agentName }: { spend: AccountSpend; color: string; summary?: ReactNode; agentName?: string }) {
  const recorded = recordedSpend(spend);
  const tokens = spend.tokensTracked !== false;
  const row = (label: string, w: SpendWindow) => (
    <div className="usage-detail-row">
      <span className="usage-detail-label">{label}</span>
      <span className="usage-detail-val" title={estimateDescription(w, recorded)}>
        <b>{estimateLabel(w)}</b>{tokens ? <> · {fmtTokens(w.tokens)} tokens</> : null}
      </span>
    </div>
  );
  const source = agentName ? `${agentName}'s` : "the agent's";
  const note = recorded ? `Cost recorded in ${source} own session data, not an estimate.` : "API estimate (short context), not billed spend.";
  return (
    <div
      className={`usage-detail${summary ? " usage-detail-row-only" : ""}`}
      title={recorded ? `Cost from ${source} local session records.` : "Standard short-context API-equivalent estimates from local token counts. Long-context and service-tier adjustments are not included."}
    >
      <details className="usage-more-details">
        <summary>{summary ?? "More"}</summary>
        <p className="usage-estimate-note" role="note"><Info size={12} aria-hidden="true" /><span>{note}</span></p>
        <div className="usage-detail-row">
          <span className="usage-detail-label">{tokens ? "Token trend" : "Cost trend"}</span>
          <Trend days={spend.days} color={color} byCost={!tokens} recorded={recorded} />
        </div>
        {spend.days.length > 0 && <details className="usage-daily-details">
          <summary>Daily breakdown</summary>
          <div className="usage-daily-scroll">
            <table>
              <caption>{tokens ? `Daily token usage and ${recorded ? "recorded cost" : "API-equivalent estimates"}` : "Daily recorded cost"}</caption>
              <thead><tr><th scope="col">Day</th>{tokens ? <th scope="col">Tokens</th> : null}<th scope="col">{recorded ? "Cost" : "Estimate"}</th></tr></thead>
              <tbody>{spend.days.map(day => <tr key={day.day}>
                <th scope="row">{day.day}</th>{tokens ? <td>{fmtTokens(day.tokens)}</td> : null}<td title={estimateDescription(day, recorded)}>{estimateLabel(day)}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </details>}
        <div className="usage-detail-rows">
          {row("Today", spend.today)}
          {row("Yesterday", spend.yesterday)}
          {row("Last 30 days", spend.window)}
        </div>
      </details>
    </div>
  );
}
