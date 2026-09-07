import { useState } from "react";
import { ArrowRight, ExternalLink, Globe, RotateCw, X } from "lucide-react";
import { useStore } from "../state/store";
import { HAS_TAURI } from "../tauriEnv";
import { openUrl } from "../forward";
import { CodeLayoutMenu } from "./CodeLayoutMenu";

export function previewUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter a website address.");
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use an HTTP or HTTPS address without credentials.");
  }
  if (url.origin === window.location.origin || url.hostname === "tauri.localhost" || url.port === "5190") {
    throw new Error("Choose a website or development server, not the application itself.");
  }
  return url.href;
}

export function TileBrowserPanel({ tileId }: { tileId: string }) {
  const state = useStore((s) => s.tileBrowser[tileId]);
  const setBrowser = useStore((s) => s.setTileBrowser);
  const [address, setAddress] = useState(state?.url ?? "");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  let url: string | undefined;
  try { if (state?.url) url = previewUrl(state.url); } catch { /* Invalid persisted addresses are never loaded. */ }

  return (
    <section className="tile-code tile-browser" hidden={!state?.open} aria-label="Window browser">
      <form className="tile-code-bar" onSubmit={(event) => {
        event.preventDefault();
        try {
          const next = previewUrl(address);
          setBrowser(tileId, { url: next });
          setAddress(next);
          setError("");
          setReload((value) => value + 1);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Invalid address.");
        }
      }}>
        <Globe size={14} />
        <input className="tile-browser-address" aria-label="Website address" placeholder="http://localhost:3000" value={address} onChange={(event) => setAddress(event.target.value)} spellCheck={false} autoComplete="off" />
        <button className="tile-btn" type="submit" title="Go"><ArrowRight size={13} /></button>
        <button className="tile-btn" type="button" title="Reload page" disabled={!url} onClick={() => setReload((value) => value + 1)}><RotateCw size={13} /></button>
        <button className="tile-btn" type="button" title="Open in external browser" disabled={!url} onClick={() => {
          if (!url) return;
          if (HAS_TAURI) void openUrl(url).catch(() => setError("Could not open the external browser."));
          else window.open(url, "_blank", "noopener,noreferrer");
        }}><ExternalLink size={13} /></button>
        <CodeLayoutMenu tileId={tileId} browser />
        <button className="tile-btn" type="button" title="Close browser panel" onClick={() => setBrowser(tileId, { open: false })}><X size={13} /></button>
      </form>
      {error ? <div className="tile-browser-notice" role="alert">{error}</div> : null}
      {url ? (
        <iframe key={reload} className="tile-browser-frame" title="Website preview" src={url} sandbox="allow-scripts allow-forms allow-downloads" referrerPolicy="no-referrer" />
      ) : <div className="tile-browser-empty">Enter a website address to preview it in this window.</div>}
      <div className="tile-browser-notice">Embedded preview: sites requiring browser storage or blocking embedding may need the external browser. Localhost refers to this device.</div>
    </section>
  );
}
