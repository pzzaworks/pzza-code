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
    bg: "#f6f8fa",
    surface: "#ffffff",
    surfaceAlt: "#f0f2f4",
    border: "#d1d9e0",
    controlBorder: "#818b98",
    input: "#ffffff",
    hover: "#eaeef2",
    selected: "#ddf4ff",
    selectedText: "#0550ae",
    focusRing: "#0969da",
    inactiveOverlay: "rgb(31 35 40 / 0%)",
    focusOverlay: "rgb(89 99 110 / 20%)",
    text: "#1f2328",
    muted: "#59636e",
    accent: "#0969da",
    accentText: "#ffffff",
    success: "#1a6334",
    warning: "#785000",
    danger: "#b4232d",
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

// Keep text opaque and preserve role hierarchy until the deliberate maximum.
// Surfaces and inverse-control colors are handled separately from body text.
export function textVisibilityVars(c: ChromePalette, appearance: Theme["appearance"], value: number): Record<string, string> {
  const amount = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) / 100 : 0;
  const target = appearance === "dark" ? "#ffffff" : "#000000";
  const body = amount ** 1.2;
  const secondary = amount ** 1.5;
  return {
    "--text": amount ? mix(c.text, target, body) : c.text,
    "--muted": amount ? mix(c.muted, target, secondary) : c.muted,
    "--heading-text": amount ? mix(c.text, target, amount) : c.text,
    "--visibility-settings-muted": mix(appearance === "light" ? c.muted : mix(c.surface, c.text, 0.68), target, secondary),
    "--accent-foreground": amount ? mix(c.accent, target, body) : c.accent,
    "--selected-text": amount ? mix(c.selectedText, target, body) : c.selectedText,
    "--success-foreground": amount ? mix(c.success, target, body) : c.success,
    "--warning-foreground": amount ? mix(c.warning, target, body) : c.warning,
    "--danger-foreground": amount ? mix(c.danger, target, body) : c.danger,
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
