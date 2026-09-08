import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { HAS_TAURI } from "../tauriEnv";
import { UpdatesSection } from "./SettingsMenu";
import { openUrl } from "../forward";

export function About() {
  const [error, setError] = useState<string | null>(null);
  return <div className="settings-page about-page">
    <section className="settings-section about-identity">
    <img src="/pzzacode.svg" alt="PzzaCode" className="about-logo" />
    <div><h2>PzzaCode <span className="about-version">{__APP_VERSION__}</span></h2>
    <p>Developed by <strong>Berke (pzzaworks)</strong></p></div>
    </section>
    <UpdatesSection />
    <section className="settings-section about-resources">
    <h3 className="set-title">Resources</h3>
    <div className="about-links">{[
      ["Website", "https://code.pzza.works"], ["pzza.works", "https://pzza.works"],
      ["Privacy Policy", "https://pzza.works/privacy-policy"], ["Terms & Conditions", "https://pzza.works/terms-conditions"],
    ].map(([label, url]) => <a key={url} className="about-resource" href={url} target="_blank" rel="noopener noreferrer" onClick={event => {
      if (!HAS_TAURI) return;
      event.preventDefault(); setError(null);
      void openUrl(url).catch(() => setError("Could not open the link in your browser."));
    }}><span>{label}</span><ExternalLink size={14} /></a>)}</div>
    {error ? <p role="alert">{error}</p> : null}
    </section>
  </div>;
}
