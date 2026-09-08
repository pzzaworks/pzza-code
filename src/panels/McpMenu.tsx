import { useEffect, useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { fetchMcpConfig, mcpInstall, type McpConfig } from "../serverApi";

const ENABLED_KEY = "pzza.mcp.enabled";

// MCP dropdown: a switch to expose pzzacode-mcp to agents, and per-framework
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
  const [agentHost, setAgentHost] = useState("");
  const [mcpPath, setMcpPath] = useState("");
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const timer = setTimeout(() => {
      fetchMcpConfig(agentHost.trim(), mcpPath.trim()).then((value) => {
        if (!disposed) { setCfg(value); setConfigError(null); }
      }).catch(() => { if (!disposed) { setCfg(null); setConfigError("Check the SSH host and MCP script path."); } });
    }, 200);
    return () => { disposed = true; clearTimeout(timer); };
  }, [agentHost, mcpPath]);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    try {
      localStorage.setItem(ENABLED_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent("pzza:mcp-enabled-changed", { detail: { enabled: next } }));
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
          <span>Allow app control</span>
          <span className="set-hint">let connected agents control this app window</span>
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
        Control editor panels, tile focus and layouts. Session,
        file and device tools remain available independently of this switch.
      </p>

      <label className="field"> <span className="field-label">App SSH host (optional)</span>
        <input className="field-input" value={agentHost} onChange={(event) => setAgentHost(event.target.value)} placeholder="user@app-host" spellCheck={false} />
      </label>
      {agentHost.trim() ? <>
        <label className="field"><span className="field-label">MCP script path on the agent's device</span>
          <input className="field-input" value={mcpPath} onChange={(event) => setMcpPath(event.target.value)} placeholder="/absolute/path/to/mcp/server.js" spellCheck={false} />
        </label>
        <p className="set-note">Copy this configuration into the agent on another device. That device needs Node.js, the installed MCP package, and key-based SSH access to the app host with its host key already trusted. The app must be running. Credentials stay on the app host; no public port is opened. Tools use the app host's device names and SSH access.</p>
      </> : null}
      {configError ? <p className="set-note">{configError}</p> : null}

      <div className="mcp-list">
        {frameworks.length === 0 ? (
          <p className="muted small pad">Server unreachable.</p>
        ) : (
          frameworks.map(([key, fw]) => (
            <div key={key} className="mcp-row">
              <span className="mcp-name">{fw.label}</span>
              <div className="mcp-actions">
                {note[key] ? <span className="mcp-note">{note[key]}</span> : null}
                {fw.cli && !agentHost.trim() ? (
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
                  disabled={Boolean(agentHost.trim()) && !mcpPath.trim().startsWith("/")}
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
