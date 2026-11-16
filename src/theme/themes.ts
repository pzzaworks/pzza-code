import type { Theme, TerminalPalette, ThemeAppearance } from "./types";
import { PZZACODE_LIGHT_CHROME, deriveChrome, grayscale, highContrastChrome, luminance, mix } from "./types";
import { TERMINAL_THEME_DATA } from "./terminalThemes";

// A theme is colors only: a terminal palette, and the interface colors that
// follow from it. PzzaCode and PzzaCode Light are the app's own; the rest are
// permissively licensed color schemes (see terminalThemes.ts).

export const DEFAULT_THEME_ID = "pzzacode";
const LIGHT_THEME_ID = "pzzacode-light";

function terminalOf(background: string, foreground: string, ansi: string[], extra: Partial<TerminalPalette> = {}): TerminalPalette {
  const a = ansi;
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: mix(background, foreground, 0.28),
    black: a[0], red: a[1], green: a[2], yellow: a[3], blue: a[4], magenta: a[5], cyan: a[6], white: a[7],
    brightBlack: a[8], brightRed: a[9], brightGreen: a[10], brightYellow: a[11],
    brightBlue: a[12], brightMagenta: a[13], brightCyan: a[14], brightWhite: a[15],
    ...extra,
  };
}

function own(id: string, name: string, appearance: ThemeAppearance, terminal: TerminalPalette, chrome = deriveChrome(terminal, appearance)): Theme {
  return { id, name, appearance, terminal, chrome };
}

const PZZACODE = own(DEFAULT_THEME_ID, "PzzaCode", "dark", terminalOf("#0b0e14", "#bfbdb6",
  ["#11151c", "#ea6c73", "#91b362", "#f9af4f", "#53bdfa", "#fae994", "#90e1c6", "#c7c7c7", "#686868", "#f07178", "#c2d94c", "#ffb454", "#59c2ff", "#ffee99", "#95e6cb", "#ffffff"]));
const PZZACODE_LIGHT = own(LIGHT_THEME_ID, "PzzaCode Light", "light", terminalOf("#ffffff", "#1f2328",
  ["#242830", "#ac302e", "#28623e", "#7a540a", "#245e9d", "#774699", "#17686d", "#525b68", "#606b7a", "#b32b39", "#256437", "#795308", "#185d9d", "#854298", "#126972", "#424c59"],
  { selectionBackground: "#ddf4ff" }), PZZACODE_LIGHT_CHROME);
/** PzzaCode and PzzaCode Light. */
export const PZZACODE_THEMES: readonly Theme[] = [PZZACODE, PZZACODE_LIGHT];

// High contrast, a PzzaCode original: pure black with text in one hue, every
// terminal color at 7:1 or more on black (WCAG AAA), selection and focus in
// the hue with black text on it. The terminal also keeps 7:1 for whatever
// colors a program asks for (see terminalMinimumContrast).
const HIGH_CONTRAST_ANSI = ["#4d4d4d", "#ff6b6b", "#3dff7a", "#ffe14d", "#5cadff", "#ff73ff", "#33f0ff", "#e6e6e6",
  "#a6a6a6", "#ff8f8f", "#80ffaa", "#fff080", "#8cc8ff", "#ffa6ff", "#8cf8ff", "#ffffff"];
const HIGH_CONTRAST_HUES: readonly (readonly [id: string, name: string, text: string, hue: string])[] = [
  ["high-contrast", "High Contrast", "#ffffff", "#ffd400"],
  ["high-contrast-amber", "High Contrast Amber", "#ffbf1f", "#ffbf1f"],
  ["high-contrast-green", "High Contrast Green", "#3dff7a", "#3dff7a"],
  ["high-contrast-cyan", "High Contrast Cyan", "#3ff0ff", "#3ff0ff"],
  ["high-contrast-blue", "High Contrast Blue", "#7cc4ff", "#7cc4ff"],
  ["high-contrast-violet", "High Contrast Violet", "#c7a6ff", "#c7a6ff"],
  ["high-contrast-rose", "High Contrast Rose", "#ff8ad8", "#ff8ad8"],
];
export const HIGH_CONTRAST_THEMES: readonly Theme[] = HIGH_CONTRAST_HUES.map(([id, name, text, hue]) => {
  const terminal = terminalOf("#000000", text, HIGH_CONTRAST_ANSI, { cursor: hue, cursorAccent: "#000000", selectionBackground: hue, selectionForeground: "#000000" });
  return own(id, name, "dark", terminal, highContrastChrome(terminal, hue));
});
const HIGH_CONTRAST_IDS = new Set(HIGH_CONTRAST_THEMES.map((theme) => theme.id));
const ORIGINALS: readonly Theme[] = [...PZZACODE_THEMES, ...HIGH_CONTRAST_THEMES];

// The schemes are decoded when first asked for, and kept.
type SchemeEntry = (typeof TERMINAL_THEME_DATA)[number];
const SCHEMES = new Map<string, SchemeEntry>(TERMINAL_THEME_DATA.map((entry) => [entry[0], entry]));
const decoded = new Map<string, Theme>();

function decode([id, name, colors]: SchemeEntry): Theme {
  const at = (index: number) => colors.slice(index * 6, index * 6 + 6);
  const color = (index: number) => `#${at(index)}`;
  const background = color(0);
  const foreground = color(1);
  const selectionForeground = at(5) === "------" ? undefined : color(5);
  const terminal = terminalOf(background, foreground, Array.from({ length: 16 }, (_, index) => color(6 + index)), {
    cursor: color(2), cursorAccent: color(3), selectionBackground: color(4), ...(selectionForeground ? { selectionForeground } : {}),
  });
  // Dark or light follows the colors: dark when the background is the darker one.
  return own(id, name, luminance(background) <= luminance(foreground) ? "dark" : "light", terminal);
}

function scheme(id: string): Theme | undefined {
  const cached = decoded.get(id);
  if (cached) return cached;
  const entry = SCHEMES.get(id);
  if (!entry) return undefined;
  const theme = decode(entry);
  decoded.set(id, theme);
  return theme;
}

let everyTheme: readonly Theme[] | null = null;
/** PzzaCode and PzzaCode Light, every scheme by name, then high contrast. */
export function allThemes(): readonly Theme[] {
  everyTheme ??= [...PZZACODE_THEMES, ...TERMINAL_THEME_DATA.map(([id]) => scheme(id) as Theme), ...HIGH_CONTRAST_THEMES];
  return everyTheme;
}

export function findTheme(id: string): Theme | undefined {
  return ORIGINALS.find((theme) => theme.id === id) ?? scheme(id);
}

/** The theme with this ID, or PzzaCode when it is unknown. */
export function themeById(id: string): Theme {
  return findTheme(id) ?? PZZACODE;
}

// The first two themes were saved as "dark" and "light"; an ID that no longer
// names a theme falls back to PzzaCode.
export function migrateThemeId(id: string): string {
  if (id === "dark") return DEFAULT_THEME_ID;
  if (id === "light") return LIGHT_THEME_ID;
  return findTheme(id) ? id : DEFAULT_THEME_ID;
}

// Grayscale mode neutralizes the terminal's own surface (background, text,
// cursor, selection) and keeps the 16 ANSI colors programs print with.
export function terminalPalette(theme: Theme, transparent: boolean, gray: boolean): TerminalPalette {
  const base = theme.terminal;
  const palette = gray ? {
    ...base,
    background: grayscale(base.background),
    foreground: grayscale(base.foreground),
    cursor: grayscale(base.cursor),
    cursorAccent: grayscale(base.cursorAccent),
    selectionBackground: grayscale(base.selectionBackground),
    ...(base.selectionForeground ? { selectionForeground: grayscale(base.selectionForeground) } : {}),
  } : base;
  // Retain the background RGB channels for terminal contrast and color queries.
  return transparent ? { ...palette, background: `${palette.background}00` } : palette;
}

// PzzaCode Light's terminal was tuned with xterm's contrast correction on, and
// high contrast holds every color a program prints to 7:1; every other
// palette is drawn in its own colors.
export function terminalMinimumContrast(theme: Theme): number {
  if (HIGH_CONTRAST_IDS.has(theme.id)) return 7;
  return theme.id === LIGHT_THEME_ID ? 4.5 : 1;
}
