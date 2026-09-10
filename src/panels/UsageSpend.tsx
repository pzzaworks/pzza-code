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
  const max = Math.max(...days.map((d) => d.cost ?? 0), 0.01);
  return (
    <div className="usage-trend" role="img" aria-label="Daily API-equivalent estimates, last 30 days. Outlined bars have unavailable or partial pricing.">
      {days.map((d) => (
        <span
          key={d.day}
          className="usage-trend-bar"
          style={d.cost === null
            ? { height: "100%", border: `1px dashed ${color}`, boxSizing: "border-box" }
            : { height: `${Math.max(2, Math.round((d.cost / max) * 100))}%`, background: color }}
          title={`${d.day} · ${estimateDescription(d)}`}
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
        <span className="usage-detail-label">Usage trend</span>
        <Trend days={spend.days} color={color} />
      </div>
      {row("Today", spend.today)}
      {row("Yesterday", spend.yesterday)}
      {row("Last 30 days", spend.window)}
    </div>
  );
}
