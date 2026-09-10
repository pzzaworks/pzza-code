import type { AccountSpend, SpendDay, SpendWindow } from "../serverApi";

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

function estimateLabel(w: SpendWindow): string {
  if (w.cost !== null) return fmtCost(w.cost);
  return w.pricedCost > 0 ? `${fmtCost(w.pricedCost)}+ (partial)` : "Unavailable";
}

function estimateDescription(w: SpendWindow): string {
  if (w.cost !== null) return estimateLabel(w);
  return `${estimateLabel(w)}: ${fmtTokens(w.unpricedTokens)} tokens have no verified rate (${w.unpricedModels.join(", ")}).`;
}

function Trend({ days, color }: { days: SpendDay[]; color: string }) {
  if (!days.length) return null;
  // Token counts remain measurable even when a model's price is unavailable.
  // A missing rate must not turn a day into an invented full-height spend bar.
  const max = Math.max(...days.map((day) => day.tokens), 1);
  return (
    <div className="usage-trend" role="img" aria-label="Daily token usage, last 30 days. Bar height represents tokens, not cost; pricing availability does not affect the bars.">
      {days.map((day) => (
        <span
          key={day.day}
          className="usage-trend-bar"
          style={{ height: `${day.tokens > 0 ? Math.max(2, Math.round((day.tokens / max) * 100)) : 0}%`, background: color }}
          title={`${day.day} · ${fmtTokens(day.tokens)} tokens · ${estimateDescription(day)}`}
        />
      ))}
    </div>
  );
}

export function UsageSpend({ spend, color }: { spend: AccountSpend; color: string }) {
  const row = (label: string, w: SpendWindow) => (
    <div className="usage-detail-row">
      <span className="usage-detail-label">{label}</span>
      <span className="usage-detail-val" title={estimateDescription(w)}>
        <b>{estimateLabel(w)}</b> · {fmtTokens(w.tokens)} tokens
      </span>
    </div>
  );
  return (
    <div className="usage-detail" title="Standard short-context API-equivalent estimates from local token counts. Long-context and service-tier adjustments are not included.">
      <div className="muted">API estimate (short context), not billed spend.</div>
      <div className="usage-detail-row">
        <span className="usage-detail-label">Token trend</span>
        <Trend days={spend.days} color={color} />
      </div>
      {spend.days.length > 0 && <details className="usage-daily-details">
        <summary>Daily breakdown</summary>
        <div className="usage-daily-scroll">
          <table>
            <caption>Daily token usage and API-equivalent estimates</caption>
            <thead><tr><th scope="col">Day</th><th scope="col">Tokens</th><th scope="col">Estimate</th></tr></thead>
            <tbody>{spend.days.map(day => <tr key={day.day}>
              <th scope="row">{day.day}</th><td>{fmtTokens(day.tokens)}</td><td title={estimateDescription(day)}>{estimateLabel(day)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </details>}
      {row("Today", spend.today)}
      {row("Yesterday", spend.yesterday)}
      {row("Last 30 days", spend.window)}
    </div>
  );
}
