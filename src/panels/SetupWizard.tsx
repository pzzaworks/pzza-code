import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, FolderOpen, Loader2, RefreshCw, ServerCog, X } from "lucide-react";
import { Modal } from "../ui/Modal";
import { WizardIcon } from "../ui/WizardIcon";
import { FilePicker } from "./FilePicker";
import { useStore } from "../state/store";
import {
  fetchDoctor,
  fetchSshHosts,
  installAgent,
  SERVER_HTTP,
  type Doctor,
  type SshHost,
  type SshHosts,
} from "../serverApi";

type Status = "ok" | "warn" | "fail" | "pending";
type Mode = "this" | "add";

interface CheckRow {
  label: string;
  status: Status;
  detail: string;
  hint?: string;
}

const StatusIcon = ({ status }: { status: Status }) => {
  if (status === "ok") return <Check size={15} className="sw-ic sw-ok" />;
  if (status === "warn") return <AlertTriangle size={15} className="sw-ic sw-warn" />;
  if (status === "fail") return <X size={15} className="sw-ic sw-fail" />;
  return <Loader2 size={15} className="sw-ic sw-spin" />;
};

// Setup wizard. "This device" shows the local agent's health via /doctor.
// "Add a device" takes the SSH details of another machine the user can already
// reach, and installs the agent on it over that connection - the user handles
// SSH access, we only take the connection info and drive the install.
export function SetupWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("this");
  const addDevice = useStore((s) => s.addDevice);

  // --- this device ---
  const [loading, setLoading] = useState(true);
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const check = useCallback(() => {
    setLoading(true);
    fetchDoctor()
      .then(setDoctor)
      .catch(() => setDoctor(null))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (open && mode === "this") check();
  }, [open, mode, check]);

  // --- add a device ---
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [port, setPort] = useState("");
  const [identity, setIdentity] = useState("");
  const [role, setRole] = useState<"source" | "client">("source");
  const [serverHost, setServerHost] = useState("");
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState("");
  const [done, setDone] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  // Auto-discovered SSH targets / identities from the local ~/.ssh, plus a file
  // picker for choosing an identity by hand.
  const [ssh, setSsh] = useState<SshHosts | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => {
    if (open && mode === "add" && !ssh) {
      fetchSshHosts()
        .then(setSsh)
        .catch(() => setSsh({ dir: "", hosts: [], identities: [] }));
    }
  }, [open, mode, ssh]);

  // Prefill the whole form from a detected ~/.ssh/config host.
  const applyHost = (h: SshHost) => {
    if (!name.trim()) setName(h.host);
    setTarget(h.host);
    setPort(h.port ? String(h.port) : "");
    if (h.identity) setIdentity(h.identity);
  };

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const runInstall = async () => {
    if (!target.trim() || installing) return;
    setInstalling(true);
    setDone(false);
    setLog("");
    try {
      await installAgent(
        {
          target: target.trim(),
          port: port ? Number(port) : undefined,
          identity: identity.trim() || undefined,
          serverHost: role === "client" ? serverHost.trim() : undefined,
        },
        (text) => setLog((prev) => prev + text),
      );
    } catch (e) {
      setLog((prev) => prev + `\n[failed] ${e instanceof Error ? e.message : String(e)}\n`);
    } finally {
      setInstalling(false);
      setDone(true);
    }
  };

  const succeeded = done && /DONE - agent installed/.test(log);

  const saveDevice = () => {
    addDevice(name.trim() || target.trim(), target.trim());
    setName("");
    setTarget("");
    setPort("");
    setIdentity("");
    setServerHost("");
    setLog("");
    setDone(false);
    setMode("this");
  };

  // Checklist rows for this device.
  const rows: CheckRow[] = doctor
    ? [
        {
          label: "Device agent",
          status: "ok",
          detail: `${SERVER_HTTP} · ${doctor.role}${doctor.host ? ` -> ${doctor.host}` : ""}`,
        },
        {
          label: "Persistent storage",
          status: doctor.stateWritable ? "ok" : "fail",
          detail: doctor.stateDir,
          hint: doctor.stateWritable ? undefined : "Agent cannot write here - check permissions.",
        },
        {
          label: "tmux (persistent sessions)",
          status: doctor.tmux ? "ok" : "warn",
          detail: doctor.tmux ?? "not found",
          hint: doctor.tmux ? undefined : "Install tmux: `sudo apt install tmux` / `brew install tmux`",
        },
        {
          label: "Terminal backend (node-pty)",
          status: doctor.nodePty ? "ok" : "fail",
          detail: doctor.nodePty ? "ready" : "native binding failed",
        },
      ]
    : [];

  return (
    <Modal open={open} onClose={onClose} title="Wizard" icon={WizardIcon} size="md">
      <div className="sw-header">
        <img src="/pzzacode.svg" alt="" className="sw-logo" />
        <div className="sw-brand">
          <span className="sw-brand-name">PzzaCode</span>
          <span className="sw-brand-version">v{__APP_VERSION__}</span>
        </div>
      </div>

      <div className="sw-tabs">
        <button
          className={`sw-tab ${mode === "this" ? "on" : ""}`}
          onClick={() => setMode("this")}
        >
          This device
        </button>
        <button className={`sw-tab ${mode === "add" ? "on" : ""}`} onClick={() => setMode("add")}>
          Add a device
        </button>
      </div>

      {mode === "this" ? (
        <>
          <p className="sw-lead">
            The <b>agent</b> on this machine serves your terminals, ports and saved state.
          </p>
          {loading ? (
            <div className="sw-loading">
              <Loader2 size={16} className="sw-spin" /> Checking...
            </div>
          ) : !doctor ? (
            <div className="sw-row">
              <StatusIcon status="fail" />
              <div className="sw-row-body">
                <div className="sw-row-label">No agent on {SERVER_HTTP}</div>
                <div className="sw-row-detail">
                  Install it from “Add a device”, or start it on this machine.
                </div>
              </div>
            </div>
          ) : (
            <div className="sw-checks">
              {rows.map((r) => (
                <div className="sw-row" key={r.label}>
                  <StatusIcon status={r.status} />
                  <div className="sw-row-body">
                    <div className="sw-row-label">{r.label}</div>
                    <div className="sw-row-detail">{r.detail}</div>
                    {r.hint ? <div className="sw-row-hint">{r.hint}</div> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="modal-actions">
            <button className="btn" onClick={check} disabled={loading}>
              <RefreshCw size={14} />
              Re-check
            </button>
            <button className="btn btn-accent" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="sw-lead">
            Enter the SSH details of a machine you can already reach - the agent installs itself
            there over that connection. You set up SSH; we just use it.
          </p>

          {ssh && ssh.hosts.length > 0 ? (
            <div className="sw-detected">
              <span className="sw-detected-label">From your ~/.ssh/config</span>
              <div className="sw-chips">
                {ssh.hosts.map((h) => (
                  <button
                    key={h.host}
                    type="button"
                    className={`sw-chip ${target === h.host ? "on" : ""}`}
                    title={`${h.user ? `${h.user}@` : ""}${h.hostname ?? h.host}${h.port ? `:${h.port}` : ""}`}
                    onClick={() => applyHost(h)}
                  >
                    {h.host}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="sw-form">
            <label className="sw-field">
              <span>Device name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My server" />
            </label>
            <label className="sw-field">
              <span>SSH target</span>
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="user@host or ssh alias"
                spellCheck={false}
              />
            </label>
            <div className="sw-field-row">
              <label className="sw-field">
                <span>Port</span>
                <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" />
              </label>
              <label className="sw-field sw-grow">
                <span>Identity file (optional)</span>
                <div className="sw-input-with-btn">
                  <input
                    value={identity}
                    onChange={(e) => setIdentity(e.target.value)}
                    placeholder="~/.ssh/id_ed25519"
                    spellCheck={false}
                    list="sw-identities"
                  />
                  <button
                    type="button"
                    className="sw-browse"
                    title="Choose a key file"
                    onClick={() => setPickerOpen(true)}
                  >
                    <FolderOpen size={14} />
                  </button>
                </div>
                {ssh && ssh.identities.length > 0 ? (
                  <datalist id="sw-identities">
                    {ssh.identities.map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                ) : null}
              </label>
            </div>
            <div className="sw-role">
              <button
                className={`sw-role-opt ${role === "source" ? "on" : ""}`}
                onClick={() => setRole("source")}
              >
                Source <span>has tmux</span>
              </button>
              <button
                className={`sw-role-opt ${role === "client" ? "on" : ""}`}
                onClick={() => setRole("client")}
              >
                Client <span>forwards to a source</span>
              </button>
            </div>
            {role === "client" ? (
              <label className="sw-field">
                <span>Forwards to (source host)</span>
                <input
                  value={serverHost}
                  onChange={(e) => setServerHost(e.target.value)}
                  placeholder="my-server"
                  spellCheck={false}
                />
              </label>
            ) : null}
          </div>

          {log ? (
            <pre className="sw-log" ref={logRef}>
              {log}
            </pre>
          ) : null}

          <div className="modal-actions">
            {succeeded ? (
              <button className="btn btn-accent" onClick={saveDevice}>
                <Check size={14} />
                Add to devices
              </button>
            ) : (
              <button
                className="btn btn-accent"
                onClick={runInstall}
                disabled={installing || !target.trim()}
              >
                {installing ? <Loader2 size={14} className="sw-spin" /> : <ServerCog size={14} />}
                {installing ? "Installing..." : "Install agent"}
              </button>
            )}
          </div>
        </>
      )}

      <FilePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(p) => setIdentity(p)}
        mode="file"
        start={ssh?.dir || undefined}
      />
    </Modal>
  );
}
