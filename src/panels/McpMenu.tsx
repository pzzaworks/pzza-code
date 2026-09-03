import { useEffect, useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { fetchMcpConfig, mcpInstall, type McpConfig } from "../serverApi";

const ENABLED_KEY = "pzza.mcp.enabled";

// MCP dropdown: a switch to expose pzza-console to agents, and per-framework
// add/copy so Claude / Codex / Zed / Cursor / Windsurf can reach it.
export function McpMenu() {
  const [cfg, setCfg] = useState<McpConfig | null>(null);
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem(ENABLED_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetchMcpConfig().then(setCfg).catch(() => setCfg(null));
  }, []);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    try {
      localStorage.setItem(ENABLED_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  const add = async (fw: string) => {
    setBusy(fw);
    try {
      const r = await mcpInstall(fw);
      setNote((n) => ({ ...n, [fw]: r.ok ? "added ✓" : r.error || "failed" }));
    } catch {
      setNote((n) => ({ ...n, [fw]: "failed" }));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (fw: string, config: string) => {
    try {
      await navigator.clipboard.writeText(config);
      setNote((n) => ({ ...n, [fw]: "copied ✓" }));
    } catch {
      setNote((n) => ({ ...n, [fw]: "copy failed" }));
    }
  };

  const frameworks = cfg ? Object.entries(cfg.frameworks) : [];

  return (
    <div className="menu-body">
      <div className="menu-title">MCP</div>

      <div className="mcp-toggle">
        <div className="set-label">
          <span>Expose to agents</span>
          <span className="set-hint">let Claude / Codex control the app safely</span>
        </div>
        <button
          className={`switch ${enabled ? "switch-on" : ""}`}
          onClick={toggle}
          role="switch"
          aria-checked={enabled}
        >
          <span className="switch-knob" />
        </button>
      </div>

      <p className="set-note" style={{ marginTop: 0 }}>
        Tools: list/create/kill sessions & windows, list ports, toggle
        forwarding. Add it to your agent, then it can drive the devbox.
      </p>

      <div className="mcp-list">
        {frameworks.length === 0 ? (
          <p className="muted small pad">Server unreachable.</p>
        ) : (
          frameworks.map(([key, fw]) => (
            <div key={key} className="mcp-row">
              <span className="mcp-name">{fw.label}</span>
              <div className="mcp-actions">
                {note[key] ? <span className="mcp-note">{note[key]}</span> : null}
                {fw.cli ? (
                  <button
                    className="btn btn-accent btn-sm"
                    onClick={() => add(key)}
                    disabled={busy === key || !enabled}
                  >
                    {busy === key ? "…" : <Download size={13} strokeWidth={2} />}
                    Add
                  </button>
                ) : null}
                <button
                  className="btn btn-sm"
                  onClick={() => copy(key, fw.config)}
                  title="Copy config"
                >
                  <Copy size={13} strokeWidth={2} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {cfg ? (
        <p className="set-note mcp-path" title={cfg.path}>
          <Check size={11} strokeWidth={2.5} /> server: {cfg.path}
        </p>
      ) : null}
    </div>
  );
}
