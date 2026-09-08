// Terminal colors and shared interface tokens for each appearance.

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
  controlBorder: string;
  input: string;
  hover: string;
  selected: string;
  selectedText: string;
  focusRing: string;
  inactiveOverlay: string;
  focusOverlay: string;
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
  const [r, g, b] = toRgb(hex).map((n) => {
    const channel = n / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

// Light surfaces, text and control boundaries have distinct semantic roles.
export function deriveChrome(t: TerminalPalette, appearance: Theme["appearance"]): ChromePalette {
  if (appearance === "light") return {
    bg: "#f4f5f7",
    surface: "#ffffff",
    surfaceAlt: "#edf0f4",
    border: "#d6dbe3",
    controlBorder: "#858e9b",
    input: "#ffffff",
    hover: "#e8ecf1",
    selected: "#dce5f0",
    selectedText: "#243b55",
    focusRing: "#245ea3",
    inactiveOverlay: "rgb(97 112 132 / 8%)",
    focusOverlay: "rgb(116 134 157 / 24%)",
    text: "#242830",
    muted: "#515b69",
    accent: "#424a57",
    accentText: "#ffffff",
    success: "#23633d",
    warning: "#7a510a",
    danger: "#ae2e24",
  };
  const bg = t.background;
  const fg = t.foreground;
  return {
    bg,
    surface: mix(bg, fg, 0.045),
    surfaceAlt: mix(bg, fg, 0.11),
    border: mix(bg, fg, 0.17),
    controlBorder: mix(bg, fg, 0.32),
    input: mix(bg, fg, 0.08),
    hover: mix(bg, fg, 0.14),
    selected: mix(bg, fg, 0.17),
    selectedText: fg,
    focusRing: "#8f9aab",
    inactiveOverlay: "rgb(0 0 0 / 26%)",
    focusOverlay: "rgb(27 36 52 / 30%)",
    text: fg,
    muted: mix(fg, bg, 0.45),
    accent: "#454a54",
    accentText: "#ffffff",
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
    "--control-border": c.controlBorder,
    "--input": c.input,
    "--hover": c.hover,
    "--selected": c.selected,
    "--selected-text": c.selectedText,
    "--focus-ring": c.focusRing,
    "--inactive-overlay": c.inactiveOverlay,
    "--focus-overlay": c.focusOverlay,
    "--text": c.text,
    "--muted": c.muted,
    "--accent": c.accent,
    "--accent-text": c.accentText,
    "--success": c.success,
    "--warning": c.warning,
    "--danger": c.danger,
  };
}
