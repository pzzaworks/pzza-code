import { useIntegrationHealth } from "../state/integrationHealth";
import { useStore } from "../state/store";
import { deviceHost } from "../devices";
import { AsyncButton } from "../ui/AsyncButton";
import { useEffect, useState } from "react";
import { Check, Copy, Download, RefreshCw } from "lucide-react";
import { useMcpSettings } from "../state/mcpSettings";

const ENABLED_KEY = "pzza.mcp.enabled";

// MCP dropdown: a switch to expose pzzacode-mcp to agents, and per-framework
// add/copy so Claude / Codex / Zed / Cursor / Windsurf can reach it.
export function McpMenu() {
  const devices = useStore(state => state.devices);
  const health = useIntegrationHealth(state => state.devices);
  const checkAll = useIntegrationHealth(state => state.checkAll);
  const checking = useIntegrationHealth(state => state.batch?.status === "running");
  const { config: cfg, notes: note, busy, agentHost, mcpPath, error: configError, select, load, install, copy } = useMcpSettings();
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem(ENABLED_KEY) !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    const timer = setTimeout(() => { void load().catch(() => {}); }, 200);
    return () => clearTimeout(timer);
  }, [agentHost, mcpPath, load]);

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

  const frameworks = cfg ? Object.entries(cfg.frameworks) : [];

  return (
    <div className="settings-page mcp-settings">

      <div className="settings-row">
        <div className="settings-row-copy">
          <span>Allow app window control</span>
          <small>Control sessions, workspaces, editors, and app settings.</small>
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
        <input className="field-input" disabled={busy !== null} value={agentHost} onChange={(event) => select({ agentHost: event.target.value })} placeholder="Local app (default)" spellCheck={false} /><small>Optional SSH target for an app on another device.</small>
      </label>
      {agentHost.trim() ? <>
        <label className="settings-field"><span>MCP script path</span>
          <input className="field-input" disabled={busy !== null} value={mcpPath} onChange={(event) => select({ mcpPath: event.target.value })} placeholder="/absolute/path/to/mcp/server.js" spellCheck={false} />
        </label>
        <p className="set-note">Copy this configuration into the agent on another device. That device needs Node.js, the installed MCP package, and key-based SSH access to the app host with its host key already trusted. The app must be running. Credentials stay on the app host; no public port is opened. Tools use the app host's device names and SSH access.</p>
      </> : null}
      </div>
      {configError ? <p className="set-note" role="alert">{configError}</p> : null}

      </section>
      <section className="settings-section" aria-label="Integration health">
        <div className="settings-row"><div className="settings-row-copy"><span>Automatic startup repairs</span><small>Check installed server commands on each device every minute. Preserve configuration and private backups when a repair is needed.</small></div><AsyncButton className="btn btn-sm" icon={RefreshCw} loading={checking || devices.some(device => health[deviceHost(device)]?.checking)} onClick={() => { checkAll(devices.map(device => ({ host: deviceHost(device), name: device.name }))); }}>Check now</AsyncButton></div>
        {devices.map(device => {
          const value = health[deviceHost(device)];
          return <details key={device.id} className="bridge-disclosure"><summary>{device.name} · {value?.checking ? "Checking…" : value?.error ? "Unavailable" : value?.results.some(result => result.status === "unresolved") ? "Needs attention" : value?.results.some(result => result.status === "repaired") ? "Repaired" : value?.results.length ? "Ready" : "No servers configured"}</summary>
            {value?.error ? <p role="alert">{value.error}</p> : value?.results.map((result, index) => <div key={`${result.file}:${result.server}:${index}`} className="settings-row"><div className="settings-row-copy"><span>{result.server || result.framework} · {result.status}</span><small>{result.message}</small><small>{result.file}{result.scope ? ` · ${result.scope}` : ""}{result.backup ? ` · Backup: ${result.backup}` : ""}</small></div></div>)}
          </details>;
        })}
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
                  <AsyncButton className="btn btn-accent btn-sm" onClick={() => install(key).catch(() => {})} loading={busy === key} disabled={busy !== null || !enabled} icon={Download} iconSize={13}>
                    Add
                  </AsyncButton>
                ) : null}
                <button
                  className="btn btn-sm"
                  onClick={() => { void copy(key).catch(() => {}); }}
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
