import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { HAS_TAURI } from "../tauriEnv";
import { openUrl } from "../forward";

export function About() {
  const [error, setError] = useState<string | null>(null);
  return <div className="about-page">
    <img src="/pzzacode.svg" alt="PzzaCode" className="about-logo" />
    <h2>PzzaCode</h2><span className="about-version">Version {__APP_VERSION__}</span>
    <h3>Every terminal, every agent, one grid.</h3>
    <p>A workspace for running and organizing terminals and coding agents across your machines.</p>
    <p>Developed by <strong>Berke (pzzaworks)</strong></p>
    <div className="about-links">{[
      ["Website", "https://code.pzza.works"], ["pzza.works", "https://pzza.works"],
      ["Privacy Policy", "https://pzza.works/privacy-policy"], ["Terms & Conditions", "https://pzza.works/terms-conditions"],
    ].map(([label, url]) => <a key={url} className="btn" href={url} target="_blank" rel="noopener noreferrer" onClick={event => {
      if (!HAS_TAURI) return;
      event.preventDefault(); setError(null);
      void openUrl(url).catch(() => setError("Could not open the link in your browser."));
    }}>{label}<ExternalLink size={13} /></a>)}</div>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
