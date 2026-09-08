import type { Theme, TerminalPalette } from "./types";
import { mix } from "./types";

// The terminal and app share the same dark or light appearance.
interface Spec {
  id: string;
  name: string;
  appearance: "dark" | "light";
  bg: string;
  fg: string;
  cursor?: string;
  sel?: string;
  ansi: string[]; // length 16
}

function make(s: Spec): Theme {
  const a = s.ansi;
  const terminal: TerminalPalette = {
    background: s.bg,
    foreground: s.fg,
    cursor: s.cursor ?? s.fg,
    cursorAccent: s.bg,
    selectionBackground: s.sel ?? mix(s.bg, s.fg, 0.28),
    black: a[0],
    red: a[1],
    green: a[2],
    yellow: a[3],
    blue: a[4],
    magenta: a[5],
    cyan: a[6],
    white: a[7],
    brightBlack: a[8],
    brightRed: a[9],
    brightGreen: a[10],
    brightYellow: a[11],
    brightBlue: a[12],
    brightMagenta: a[13],
    brightCyan: a[14],
    brightWhite: a[15],
  };
  return { id: s.id, name: s.name, appearance: s.appearance, terminal };
}

const DARK = make({
  id: "dark", name: "Dark", appearance: "dark", bg: "#0b0e14", fg: "#bfbdb6",
  ansi: ["#11151c", "#ea6c73", "#91b362", "#f9af4f", "#53bdfa", "#fae994", "#90e1c6", "#c7c7c7", "#686868", "#f07178", "#c2d94c", "#ffb454", "#59c2ff", "#ffee99", "#95e6cb", "#ffffff"],
});

const LIGHT = make({
  id: "light", name: "Light", appearance: "light", bg: "#ffffff", fg: "#1f2328", sel: "#ddf4ff",
  ansi: ["#242830", "#ac302e", "#28623e", "#7a540a", "#245e9d", "#774699", "#17686d", "#525b68", "#606b7a", "#b32b39", "#256437", "#795308", "#185d9d", "#854298", "#126972", "#424c59"],
});

export const BUILTIN_THEMES: Theme[] = [DARK, LIGHT];
export const DEFAULT_THEME_ID = "dark";

// Preserve the saved appearance once when migrating the retired palette picker.
export function migrateThemeId(id: string): string {
  return ["light", "catppuccin-latte", "gruvbox-light", "one-light", "solarized-light", "rose-pine-dawn", "everforest-light", "github-light"].includes(id) ? "light" : "dark";
}

export function themeById(id: string): Theme {
  return id === "light" ? LIGHT : DARK;
}

export function terminalPalette(id: string, transparent: boolean): TerminalPalette {
  const palette = themeById(id).terminal;
  // Retain the background RGB channels for terminal contrast and color queries.
  return transparent ? { ...palette, background: `${palette.background}00` } : palette;
}
