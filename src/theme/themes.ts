import type { Theme, TerminalPalette } from "./types";
import { mix } from "./types";

// Compact theme spec: background, foreground, and the 16 ANSI colors in order
// (black..white, then bright black..bright white). Cursor/selection default
// from bg/fg. This keeps each theme to a few lines so the library can be large.
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

const SPECS: Spec[] = [
  { id: "tokyo-night", name: "Tokyo Night", appearance: "dark", bg: "#1a1b26", fg: "#c0caf5",
    ansi: ["#15161e","#f7768e","#9ece6a","#e0af68","#7aa2f7","#bb9af7","#7dcfff","#a9b1d6","#414868","#f7768e","#9ece6a","#e0af68","#7aa2f7","#bb9af7","#7dcfff","#c0caf5"] },
  { id: "tokyo-night-storm", name: "Tokyo Night Storm", appearance: "dark", bg: "#24283b", fg: "#c0caf5",
    ansi: ["#1d202f","#f7768e","#9ece6a","#e0af68","#7aa2f7","#bb9af7","#7dcfff","#a9b1d6","#414868","#f7768e","#9ece6a","#e0af68","#7aa2f7","#bb9af7","#7dcfff","#c0caf5"] },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", appearance: "dark", bg: "#1e1e2e", fg: "#cdd6f4",
    ansi: ["#45475a","#f38ba8","#a6e3a1","#f9e2af","#89b4fa","#f5c2e7","#94e2d5","#bac2de","#585b70","#f38ba8","#a6e3a1","#f9e2af","#89b4fa","#f5c2e7","#94e2d5","#a6adc8"] },
  { id: "catppuccin-macchiato", name: "Catppuccin Macchiato", appearance: "dark", bg: "#24273a", fg: "#cad3f5",
    ansi: ["#494d64","#ed8796","#a6da95","#eed49f","#8aadf4","#f5bde6","#8bd5ca","#b8c0e0","#5b6078","#ed8796","#a6da95","#eed49f","#8aadf4","#f5bde6","#8bd5ca","#a5adcb"] },
  { id: "catppuccin-frappe", name: "Catppuccin Frappe", appearance: "dark", bg: "#303446", fg: "#c6d0f5",
    ansi: ["#51576d","#e78284","#a6d189","#e5c890","#8caaee","#f4b8e4","#81c8be","#b5bfe2","#626880","#e78284","#a6d189","#e5c890","#8caaee","#f4b8e4","#81c8be","#a5adce"] },
  { id: "catppuccin-latte", name: "Catppuccin Latte", appearance: "light", bg: "#eff1f5", fg: "#4c4f69",
    ansi: ["#5c5f77","#d20f39","#40a02b","#df8e1d","#1e66f5","#ea76cb","#179299","#acb0be","#6c6f85","#d20f39","#40a02b","#df8e1d","#1e66f5","#ea76cb","#179299","#bcc0cc"] },
  { id: "dracula", name: "Dracula", appearance: "dark", bg: "#282a36", fg: "#f8f8f2",
    ansi: ["#21222c","#ff5555","#50fa7b","#f1fa8c","#bd93f9","#ff79c6","#8be9fd","#f8f8f2","#6272a4","#ff6e6e","#69ff94","#ffffa5","#d6acff","#ff92df","#a4ffff","#ffffff"] },
  { id: "nord", name: "Nord", appearance: "dark", bg: "#2e3440", fg: "#d8dee9",
    ansi: ["#3b4252","#bf616a","#a3be8c","#ebcb8b","#81a1c1","#b48ead","#88c0d0","#e5e9f0","#4c566a","#bf616a","#a3be8c","#ebcb8b","#81a1c1","#b48ead","#8fbcbb","#eceff4"] },
  { id: "gruvbox-dark", name: "Gruvbox Dark", appearance: "dark", bg: "#282828", fg: "#ebdbb2",
    ansi: ["#282828","#cc241d","#98971a","#d79921","#458588","#b16286","#689d6a","#a89984","#928374","#fb4934","#b8bb26","#fabd2f","#83a598","#d3869b","#8ec07c","#ebdbb2"] },
  { id: "gruvbox-light", name: "Gruvbox Light", appearance: "light", bg: "#fbf1c7", fg: "#3c3836",
    ansi: ["#fbf1c7","#cc241d","#98971a","#d79921","#458588","#b16286","#689d6a","#7c6f64","#928374","#9d0006","#79740e","#b57614","#076678","#8f3f71","#427b58","#3c3836"] },
  { id: "one-dark", name: "One Dark", appearance: "dark", bg: "#282c34", fg: "#abb2bf",
    ansi: ["#282c34","#e06c75","#98c379","#e5c07b","#61afef","#c678dd","#56b6c2","#abb2bf","#5c6370","#e06c75","#98c379","#e5c07b","#61afef","#c678dd","#56b6c2","#ffffff"] },
  { id: "one-light", name: "One Light", appearance: "light", bg: "#fafafa", fg: "#383a42",
    ansi: ["#383a42","#e45649","#50a14f","#c18401","#4078f2","#a626a4","#0184bc","#a0a1a7","#696c77","#e45649","#50a14f","#c18401","#4078f2","#a626a4","#0184bc","#383a42"] },
  { id: "monokai", name: "Monokai", appearance: "dark", bg: "#272822", fg: "#f8f8f2",
    ansi: ["#272822","#f92672","#a6e22e","#f4bf75","#66d9ef","#ae81ff","#a1efe4","#f8f8f2","#75715e","#f92672","#a6e22e","#f4bf75","#66d9ef","#ae81ff","#a1efe4","#f9f8f5"] },
  { id: "solarized-dark", name: "Solarized Dark", appearance: "dark", bg: "#002b36", fg: "#839496",
    ansi: ["#073642","#dc322f","#859900","#b58900","#268bd2","#d33682","#2aa198","#eee8d5","#002b36","#cb4b16","#586e75","#657b83","#839496","#6c71c4","#93a1a1","#fdf6e3"] },
  { id: "solarized-light", name: "Solarized Light", appearance: "light", bg: "#fdf6e3", fg: "#657b83",
    ansi: ["#073642","#dc322f","#859900","#b58900","#268bd2","#d33682","#2aa198","#eee8d5","#002b36","#cb4b16","#586e75","#657b83","#839496","#6c71c4","#93a1a1","#fdf6e3"] },
  { id: "rose-pine", name: "Rosé Pine", appearance: "dark", bg: "#191724", fg: "#e0def4",
    ansi: ["#26233a","#eb6f92","#31748f","#f6c177","#9ccfd8","#c4a7e7","#ebbcba","#e0def4","#6e6a86","#eb6f92","#31748f","#f6c177","#9ccfd8","#c4a7e7","#ebbcba","#e0def4"] },
  { id: "rose-pine-moon", name: "Rosé Pine Moon", appearance: "dark", bg: "#232136", fg: "#e0def4",
    ansi: ["#393552","#eb6f92","#3e8fb0","#f6c177","#9ccfd8","#c4a7e7","#ea9a97","#e0def4","#6e6a86","#eb6f92","#3e8fb0","#f6c177","#9ccfd8","#c4a7e7","#ea9a97","#e0def4"] },
  { id: "rose-pine-dawn", name: "Rosé Pine Dawn", appearance: "light", bg: "#faf4ed", fg: "#575279",
    ansi: ["#f2e9e1","#b4637a","#286983","#ea9d34","#56949f","#907aa9","#d7827e","#575279","#9893a5","#b4637a","#286983","#ea9d34","#56949f","#907aa9","#d7827e","#575279"] },
  { id: "everforest-dark", name: "Everforest Dark", appearance: "dark", bg: "#2d353b", fg: "#d3c6aa",
    ansi: ["#475258","#e67e80","#a7c080","#dbbc7f","#7fbbb3","#d699b6","#83c092","#d3c6aa","#5c6a72","#e67e80","#a7c080","#dbbc7f","#7fbbb3","#d699b6","#83c092","#d3c6aa"] },
  { id: "everforest-light", name: "Everforest Light", appearance: "light", bg: "#fdf6e3", fg: "#5c6a72",
    ansi: ["#e0dcc7","#f85552","#8da101","#dfa000","#3a94c5","#df69ba","#35a77c","#5c6a72","#a6b0a0","#f85552","#8da101","#dfa000","#3a94c5","#df69ba","#35a77c","#5c6a72"] },
  { id: "kanagawa", name: "Kanagawa", appearance: "dark", bg: "#1f1f28", fg: "#dcd7ba",
    ansi: ["#16161d","#c34043","#76946a","#c0a36e","#7e9cd8","#957fb8","#6a9589","#c8c093","#727169","#e82424","#98bb6c","#e6c384","#7fb4ca","#938aa9","#7aa89f","#dcd7ba"] },
  { id: "ayu-dark", name: "Ayu Dark", appearance: "dark", bg: "#0b0e14", fg: "#bfbdb6",
    ansi: ["#11151c","#ea6c73","#91b362","#f9af4f","#53bdfa","#fae994","#90e1c6","#c7c7c7","#686868","#f07178","#c2d94c","#ffb454","#59c2ff","#ffee99","#95e6cb","#ffffff"] },
  { id: "ayu-mirage", name: "Ayu Mirage", appearance: "dark", bg: "#1f2430", fg: "#cbccc6",
    ansi: ["#191e2a","#ed8274","#a6cc70","#fad07b","#6dcbfa","#cfbafa","#90e1c6","#c7c7c7","#686868","#f28779","#bae67e","#ffd580","#73d0ff","#d4bfff","#95e6cb","#ffffff"] },
  { id: "night-owl", name: "Night Owl", appearance: "dark", bg: "#011627", fg: "#d6deeb",
    ansi: ["#011627","#ef5350","#22da6e","#c5e478","#82aaff","#c792ea","#21c7a8","#ffffff","#575656","#ef5350","#22da6e","#ffeb95","#82aaff","#c792ea","#7fdbca","#ffffff"] },
  { id: "material", name: "Material", appearance: "dark", bg: "#263238", fg: "#eeffff",
    ansi: ["#000000","#f07178","#c3e88d","#ffcb6b","#82aaff","#c792ea","#89ddff","#eeffff","#546e7a","#f07178","#c3e88d","#ffcb6b","#82aaff","#c792ea","#89ddff","#ffffff"] },
  { id: "palenight", name: "Palenight", appearance: "dark", bg: "#292d3e", fg: "#a6accd",
    ansi: ["#292d3e","#f07178","#c3e88d","#ffcb6b","#82aaff","#c792ea","#89ddff","#d0d0d0","#434758","#ff8b92","#ddffa7","#ffe585","#9cc4ff","#e1acff","#a3f7ff","#ffffff"] },
  { id: "nightfox", name: "Nightfox", appearance: "dark", bg: "#192330", fg: "#cdcecf",
    ansi: ["#393b44","#c94f6d","#81b29a","#dbc074","#719cd6","#9d79d6","#63cdcf","#dfdfe0","#575860","#d16983","#8ebaa4","#e0c989","#86abdc","#baa1e2","#7ad5d6","#e4e4e5"] },
  { id: "oceanic-next", name: "Oceanic Next", appearance: "dark", bg: "#1b2b34", fg: "#cdd3de",
    ansi: ["#1b2b34","#ec5f67","#99c794","#fac863","#6699cc","#c594c5","#5fb3b3","#c0c5ce","#65737e","#ec5f67","#99c794","#fac863","#6699cc","#c594c5","#5fb3b3","#d8dee9"] },
  { id: "github-dark", name: "GitHub Dark", appearance: "dark", bg: "#0d1117", fg: "#c9d1d9",
    ansi: ["#484f58","#ff7b72","#3fb950","#d29922","#58a6ff","#bc8cff","#39c5cf","#b1bac4","#6e7681","#ffa198","#56d364","#e3b341","#79c0ff","#d2a8ff","#56d4dd","#f0f6fc"] },
  { id: "github-light", name: "GitHub Light", appearance: "light", bg: "#ffffff", fg: "#24292f",
    ansi: ["#24292f","#cf222e","#116329","#4d2d00","#0969da","#8250df","#1b7c83","#6e7781","#57606a","#a40e26","#1a7f37","#633c01","#218bff","#a475f9","#3192aa","#8c959f"] },
  { id: "aura", name: "Aura", appearance: "dark", bg: "#15141b", fg: "#edecee",
    ansi: ["#110f18","#ff6767","#61ffca","#ffca85","#a277ff","#a277ff","#61ffca","#edecee","#4d4d4d","#ffca85","#61ffca","#ffca85","#a277ff","#a277ff","#61ffca","#edecee"] },
  { id: "moonfly", name: "Moonfly", appearance: "dark", bg: "#080808", fg: "#bdbdbd",
    ansi: ["#323437","#ff5454","#8cc85f","#e3c78a","#80a0ff","#cf87e8","#79dac8","#c6c6c6","#949494","#ff5189","#36c692","#c6c684","#74b2ff","#ae81ff","#85dc85","#e4e4e4"] },
  { id: "horizon", name: "Horizon", appearance: "dark", bg: "#1c1e26", fg: "#d5d8da",
    ansi: ["#16161c","#e95678","#29d398","#fab795","#26bbd9","#ee64ac","#59e1e3","#d5d8da","#5b5858","#ec6a88","#3fdaa4","#fbc3a7","#3fc4de","#f075b7","#6be4e6","#d5d8da"] },
  { id: "cobalt2", name: "Cobalt2", appearance: "dark", bg: "#132738", fg: "#ffffff",
    ansi: ["#000000","#ff0000","#38de21","#ffe50a","#1460d2","#ff005d","#00bbbb","#bbbbbb","#555555","#f40e17","#3bd01d","#edc809","#5555ff","#ff55ff","#6ae3f9","#ffffff"] },
  { id: "synthwave", name: "Synthwave '84", appearance: "dark", bg: "#262335", fg: "#ffffff",
    ansi: ["#262335","#fe4450","#72f1b8","#fede5d","#03edf9","#ff7edb","#03edf9","#ffffff","#495495","#fe4450","#72f1b8","#fede5d","#03edf9","#ff7edb","#03edf9","#ffffff"] },
];

export const BUILTIN_THEMES: Theme[] = SPECS.map(make);

export const DEFAULT_THEME_ID = "ayu-dark";

export function themeById(id: string): Theme {
  return BUILTIN_THEMES.find((t) => t.id === id) ?? BUILTIN_THEMES[0];
}
