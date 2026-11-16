import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../state/store";
import { Select, type Option } from "../ui/Select";
import { HIGH_CONTRAST_THEMES, PZZACODE_THEMES, allThemes } from "../theme/themes";
import { useThemePreview } from "../theme/useActiveTheme";
import type { Theme } from "../theme/types";

// Settings > Appearance: the theme, picked from a searchable list. Moving
// through the list shows each theme on the whole app; closing it without a
// choice goes back to the theme in use.
const OWN = new Set(PZZACODE_THEMES.map((theme) => theme.id));
const HIGH_CONTRAST = new Set(HIGH_CONTRAST_THEMES.map((theme) => theme.id));
// Holding an arrow key skips through themes without repainting every
// terminal for each one it passes.
const PREVIEW_DELAY = 70;

// A tiny sample of the theme: its text on its background over a strip of its
// colors. High contrast themes share their palette, so theirs shows the one
// hue that tells them apart.
function Swatch({ theme }: { theme: Theme }) {
  const t = theme.terminal;
  const colors = HIGH_CONTRAST.has(theme.id) ? [t.cursor] : [t.red, t.yellow, t.green, t.cyan, t.blue, t.magenta];
  return <span className="theme-swatch" style={{ background: t.background, borderColor: theme.chrome.border, color: t.foreground }} aria-hidden="true">
    Aa
    <span className="theme-swatch-strip">{colors.map((color, index) => <i key={index} style={{ background: color }} />)}</span>
  </span>;
}

export function ThemeSelect() {
  const themeId = useStore((state) => state.themeId);
  const setTheme = useStore((state) => state.setTheme);
  // PzzaCode's own, then the schemes as dark and light, high contrast last.
  const options = useMemo<Option[]>(() => {
    const groupOf = (theme: Theme) => (OWN.has(theme.id) ? "PzzaCode" : HIGH_CONTRAST.has(theme.id) ? "High contrast" : theme.appearance === "dark" ? "Dark" : "Light");
    const order = ["PzzaCode", "Dark", "Light", "High contrast"];
    return [...allThemes()].sort((a, b) => order.indexOf(groupOf(a)) - order.indexOf(groupOf(b))).map((theme) => ({
      value: theme.id,
      label: theme.name,
      icon: <Swatch theme={theme} />,
      keywords: HIGH_CONTRAST.has(theme.id) ? [theme.appearance, "black", "accessible", "hc"] : [theme.appearance],
      group: groupOf(theme),
    }));
  }, []);
  const timer = useRef<number>();
  const preview = (id: string | null) => {
    window.clearTimeout(timer.current);
    // Closing shows the theme in use again at once.
    if (id === null) useThemePreview.setState({ id: null });
    else timer.current = window.setTimeout(() => useThemePreview.setState({ id }), PREVIEW_DELAY);
  };
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    useThemePreview.setState({ id: null });
  }, []);
  return <Select className="theme-select" value={themeId} options={options} onChange={setTheme} onPreview={preview} ariaLabel="Theme" align="end" searchable />;
}
