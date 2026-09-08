import { AsyncButton } from "../ui/AsyncButton";
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
    <div className="settings-page mcp-settings">

      <div className="settings-row">
        <div className="settings-row-copy">
          <span>Allow app window control</span>
          <small>Control editor panels, tile focus and layouts.</small>
        </div>
        <button
          className={`switch ${enabled ? "switch-on" : ""}`}
          onClick={toggle}
          role="switch"
          aria-label="Allow app window control"
          aria-checked={enabled}
        >
          <span className="switch-knob" />
        </button>
      </div>

      <p className="set-note">Session, file and device tools remain available when window control is off.</p>
      <section className="settings-section" aria-label="Connection">
      <div className="settings-form">
      <label className="settings-field"><span>App SSH host</span>
        <input className="field-input" value={agentHost} onChange={(event) => setAgentHost(event.target.value)} placeholder="Local app (default)" spellCheck={false} /><small>Optional SSH target for an app on another device.</small>
      </label>
      {agentHost.trim() ? <>
        <label className="settings-field"><span>MCP script path</span>
          <input className="field-input" value={mcpPath} onChange={(event) => setMcpPath(event.target.value)} placeholder="/absolute/path/to/mcp/server.js" spellCheck={false} />
        </label>
        <p className="set-note">Copy this configuration into the agent on another device. That device needs Node.js, the installed MCP package, and key-based SSH access to the app host with its host key already trusted. The app must be running. Credentials stay on the app host; no public port is opened. Tools use the app host's device names and SSH access.</p>
      </> : null}
      </div>
      {configError ? <p className="set-note" role="alert">{configError}</p> : null}

      </section>
      <section className="settings-section" aria-label="Integrations">
      <h3 className="set-title">Integrations</h3>
      <div className="mcp-list">
        {frameworks.length === 0 ? (
          <p className="settings-empty">Server unreachable.</p>
        ) : (
          frameworks.map(([key, fw]) => (
            <div key={key} className="settings-row mcp-row">
              <div className="settings-row-copy"><span>{fw.label}</span>{note[key] ? <small role="status">{note[key]}</small> : null}</div>
              <div className="settings-actions">
                {fw.cli && !agentHost.trim() ? (
                  <AsyncButton className="btn btn-accent btn-sm" onClick={() => add(key)} loading={busy === key} disabled={busy !== null || !enabled} icon={Download} iconSize={13}>
                    Add
                  </AsyncButton>
                ) : null}
                <button
                  className="btn btn-sm"
                  onClick={() => copy(key, fw.config)}
                  disabled={Boolean(agentHost.trim()) && !mcpPath.trim().startsWith("/")}
                  title="Copy configuration" aria-label={`Copy ${fw.label} configuration`}
                >
                  <Copy size={13} strokeWidth={2} /> Copy
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      </section>
      {cfg ? (
        <p className="set-note mcp-path" title={cfg.path}>
          <Check size={11} strokeWidth={2.5} /> server: {cfg.path}
        </p>
      ) : null}
    </div>
  );
}
