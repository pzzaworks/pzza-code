import { useEffect, useRef, useState } from "react";
import { Check, Loader2, ServerCog } from "lucide-react";
import { Modal } from "../ui/Modal";
import { PathField } from "../ui/PathField";
import { useStore } from "../state/store";
import { fetchSshHosts, installAgent, type SshHost, type SshHosts } from "../serverApi";

// Add a device: takes the SSH details of another machine the user can already
// reach, and installs the agent on it over that connection - the user handles
// SSH access, we only take the connection info and drive the install. Setting
// up this machine is part of the onboarding tour.
export function SetupWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const addDevice = useStore((s) => s.addDevice);

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
  useEffect(() => {
    if (open && !ssh) {
      fetchSshHosts()
        .then(setSsh)
        .catch(() => setSsh({ dir: "", hosts: [], identities: [] }));
    }
  }, [open, ssh]);

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
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Add a device" icon={ServerCog} size="md">
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
            <PathField
              value={identity}
              mode="file"
              start={ssh?.dir || undefined}
              placeholder="~/.ssh/id_ed25519"
              title="Choose a key file"
              pickerTitle="SSH identity file"
              onChange={(p) => setIdentity(p)}
            />
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
    </Modal>
  );
}
