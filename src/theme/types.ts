// A theme is authored as just a terminal palette (background/foreground/cursor
// + 16 ANSI colors). The app-chrome palette is derived from it, so adding a new
// theme means adding one palette - which is how we can ship a large library.

export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ChromePalette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  success: string;
  warning: string;
  danger: string;
}

export interface Theme {
  id: string;
  name: string;
  appearance: "dark" | "light";
  terminal: TerminalPalette;
}

// ---- color helpers ----
function clamp(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}
function toRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const v =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}
function toHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((n) => clamp(n).toString(16).padStart(2, "0")).join("");
}
// Linear blend: t=0 -> a, t=1 -> b.
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = toRgb(a);
  const [br, bg, bb] = toRgb(b);
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}
export function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((n) => n / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Build the app-chrome palette from a terminal palette.
export function deriveChrome(t: TerminalPalette, appearance: Theme["appearance"]): ChromePalette {
  const bg = t.background;
  const fg = t.foreground;
  const accent = t.brightBlue || t.blue;
  const darken = appearance === "dark";
  // White sits on the accent unless the accent is genuinely near-white.
  const accentText = luminance(accent) > 0.78 ? "#0b0b0f" : "#ffffff";
  return {
    bg,
    surface: mix(bg, darken ? fg : "#000000", 0.045),
    surfaceAlt: mix(bg, fg, 0.11),
    border: mix(bg, fg, 0.17),
    text: fg,
    muted: mix(fg, bg, 0.45),
    accent,
    accentText,
    success: t.green,
    warning: t.yellow,
    danger: t.red,
  };
}

export function chromeToCssVars(c: ChromePalette): Record<string, string> {
  return {
    "--bg": c.bg,
    "--surface": c.surface,
    "--surface-alt": c.surfaceAlt,
    "--border": c.border,
    "--text": c.text,
    "--muted": c.muted,
    "--accent": c.accent,
    "--accent-text": c.accentText,
    "--success": c.success,
    "--warning": c.warning,
    "--danger": c.danger,
  };
}
