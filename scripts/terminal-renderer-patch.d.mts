import type { Plugin } from "vite";
import type { Plugin as EsbuildPlugin } from "esbuild";

export function patchTerminalRenderer(source: string, renderer: "xterm" | "addon-webgl", version: string): string;
export function terminalRendererPatch(): Plugin;
export function terminalRendererOptimizerPatch(): EsbuildPlugin;
