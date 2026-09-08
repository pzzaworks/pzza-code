import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from "../theme/themes";
import { useStore } from "../state/store";
import { ScrollMore } from "../ui/ScrollMore";

export function ThemeSettings() {
  const themeId = useStore(state => state.themeId);
  const setTheme = useStore(state => state.setTheme);
  const [query, setQuery] = useState("");
  const [appearance, setAppearance] = useState<"all" | "dark" | "light">("all");
  const [limit, setLimit] = useState(12);
  const themes = useMemo(() => [...BUILTIN_THEMES].sort((a, b) => a.id === DEFAULT_THEME_ID ? -1 : b.id === DEFAULT_THEME_ID ? 1 : a.name.localeCompare(b.name))
    .filter(theme => (appearance === "all" || theme.appearance === appearance) && theme.name.toLowerCase().includes(query.trim().toLowerCase())), [query, appearance]);
  return <div className="theme-settings">
    <div className="theme-controls"><label className="theme-search"><Search size={15} /><input className="input" aria-label="Search themes" placeholder="Search themes…" value={query} onChange={event => { setQuery(event.target.value); setLimit(12); }} /></label>
      <div className="notification-actions">{(["all", "dark", "light"] as const).map(value => <button className={`btn btn-sm ${appearance === value ? "btn-on" : ""}`} aria-pressed={appearance === value} key={value} onClick={() => { setAppearance(value); setLimit(12); }}>{value === "all" ? "All themes" : value === "dark" ? "Dark" : "Light"}</button>)}</div>
    </div>
    <div className="notification-actions"><span className="set-note">{themes.length} themes · Applies immediately and saves on this device</span><button className="btn btn-sm" onClick={() => setTheme(DEFAULT_THEME_ID)}>Reset to Pzza</button></div>
    <div className="theme-gallery">{themes.slice(0, limit).map(theme => {
      const palette = theme.terminal;
      return <button key={theme.id} className={`theme-card ${theme.id === themeId ? "selected" : ""}`} aria-pressed={theme.id === themeId} aria-label={`Use ${theme.name} theme`} onClick={() => setTheme(theme.id)}>
        <div className="theme-preview" style={{ background: palette.background, color: palette.foreground }}>
          <div className="theme-preview-dots" aria-hidden="true"><i style={{ background: palette.red }} /><i style={{ background: palette.yellow }} /><i style={{ background: palette.green }} /></div>
          <code><span style={{ color: palette.cyan }}>~/projects</span> <span style={{ color: palette.magenta }}>main</span><br /><span style={{ color: palette.green }}>❯</span> ready to build<br /><span style={{ color: palette.brightBlack }}>Every terminal, one grid.</span></code>
          <div className="theme-swatches" aria-hidden="true">{[palette.red, palette.green, palette.yellow, palette.blue, palette.magenta, palette.cyan].map((color, index) => <i key={index} style={{ background: color }} />)}</div>
        </div>
        <span className="theme-card-label"><strong>{theme.name}</strong><span>{theme.id === DEFAULT_THEME_ID ? "Default" : theme.appearance}{theme.id === themeId ? <Check size={14} /> : null}</span></span>
      </button>;
    })}</div>
    {!themes.length ? <p className="set-note">No themes match your search.</p> : null}
    <ScrollMore hasMore={limit < themes.length} loadMore={() => setLimit(value => value + 12)} />
  </div>;
}
