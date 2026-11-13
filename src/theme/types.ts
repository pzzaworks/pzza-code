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
  // Translucent text-tinted lines, so they read the same on any surface
  // (solid or glass): row and section separators, container and floating
  // surface edges, and resting control edges.
  divider: string;
  hairline: string;
  hairlineStrong: string;
  input: string;
  hover: string;
  selected: string;
  selectedText: string;
  // The edge that marks a selected row or option against its surroundings.
  selectedEdge: string;
  // Unfilled part of meters, progress bars and slider rails.
  track: string;
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
// A color at a given opacity, as rgb(r g b / a%).
function translucent(hex: string, percent: number): string {
  const [r, g, b] = toRgb(hex);
  return `rgb(${r} ${g} ${b} / ${percent}%)`;
}

// Neutral gray with the same relative luminance, so every contrast ratio the
// theme was tuned for survives. Accepts #rgb/#rrggbb and rgb(r g b / a).
export function grayscale(color: string): string {
  const rgb = /^rgb\((\d+) (\d+) (\d+)( \/ [^)]+)?\)$/.exec(color);
  const hex = rgb ? toHex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3])) : color;
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return color;
  const y = luminance(hex);
  const channel = 255 * (y <= 0.0031308 ? y * 12.92 : 1.055 * y ** (1 / 2.4) - 0.055);
  const gray = clamp(channel);
  return rgb ? `rgb(${gray} ${gray} ${gray}${rgb[4] ?? ""})` : toHex(gray, gray, gray);
}

// Grayscale mode: the tinted interface turns neutral; status colors keep
// their meaning and are left alone.
export function grayscaleChrome(c: ChromePalette): ChromePalette {
  const keep = new Set<keyof ChromePalette>(["success", "warning", "danger"]);
  const next = { ...c };
  for (const key of Object.keys(c) as (keyof ChromePalette)[]) if (!keep.has(key)) next[key] = grayscale(c[key]);
  return next;
}

export function contrastRatio(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

// Light surfaces, text and control boundaries have distinct semantic roles.
export function deriveChrome(t: TerminalPalette, appearance: Theme["appearance"]): ChromePalette {
  if (appearance === "light") return {
    // Panels sit a notch below white with a cool tint; only fields come close to it.
    bg: "#f2f4f6",
    surface: "#f9fafb",
    surfaceAlt: "#eaedf0",
    border: "#d1d9e0",
    controlBorder: "#78828e",
    divider: translucent("#1f2328", 7),
    hairline: translucent("#1f2328", 10),
    hairlineStrong: translucent("#1f2328", 16),
    input: "#fbfcfd",
    hover: "#e4e8ec",
    selected: "#c4d9f5",
    selectedText: "#0550ae",
    selectedEdge: "#3a87dd",
    track: "#bfc8d2",
    focusRing: "#0969da",
    inactiveOverlay: "rgb(31 35 40 / 0%)",
    focusOverlay: "rgb(89 99 110 / 20%)",
    text: "#1f2328",
    muted: "#545e69",
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
    // Lines stay quiet but readable; control boundaries reach 3:1 on fields
    // and panels, as in the light palette.
    border: mix(bg, fg, 0.24),
    controlBorder: mix(bg, fg, 0.51),
    divider: translucent(fg, 8),
    hairline: translucent(fg, 12),
    hairlineStrong: translucent(fg, 18),
    input: mix(bg, fg, 0.08),
    hover: mix(bg, fg, 0.14),
    selected: mix(bg, fg, 0.17),
    selectedText: fg,
    selectedEdge: mix(bg, fg, 0.32),
    track: mix(bg, fg, 0.11),
    focusRing: "#8f9aab",
    inactiveOverlay: "rgb(0 0 0 / 26%)",
    focusOverlay: "rgb(27 36 52 / 30%)",
    text: fg,
    // Secondary text keeps 4.5:1 even on a hovered row; the neutral button
    // fill separates from panels at 3:1 with white text above 6:1.
    muted: mix(fg, bg, 0.27),
    accent: "#5f636c",
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
    "--divider": c.divider,
    "--hairline": c.hairline,
    "--hairline-strong": c.hairlineStrong,
    "--input": c.input,
    "--hover": c.hover,
    "--selected": c.selected,
    "--selected-text": c.selectedText,
    "--selected-edge": c.selectedEdge,
    "--track": c.track,
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
