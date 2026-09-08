import { useEffect, useLayoutEffect } from "react";
import { useStore } from "../state/store";
import { HAS_TAURI } from "../tauriEnv";
import { setNativeTransparency } from "../nativeAppearance";
import { themeById } from "./themes";
import { chromeToCssVars, deriveChrome } from "./types";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const themeId = useStore((s) => s.themeId);
  const transparent = useStore((s) => s.semiTransparent);
  const options = useStore((s) => s.transparencyOptions);
  const nativeBlurRadius = transparent && options.desktopBlur ? options.desktopBlurRadius : 0;

  useEffect(() => {
    let alive = true;
    if (!HAS_TAURI) {
      useStore.getState().setTransparencyNotice(transparent ? "In the browser, blur applies inside the page. Desktop blur is available in the supported desktop app." : null);
      return;
    }
    let timer: number;
    const apply = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void setNativeTransparency(transparent, nativeBlurRadius).then((result) => {
          if (alive) useStore.getState().setTransparencyNotice(result.reason ?? null);
        }).catch(() => {
          if (alive) useStore.getState().setTransparencyNotice("Desktop blur is unavailable. Translucent app surfaces are still enabled.");
        });
      }, 80);
    };
    apply();
    // A full-screen transition changes native corner clipping as well as size.
    const isMac = /mac/i.test(navigator.platform || navigator.userAgent);
    if (isMac) window.addEventListener("resize", apply);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      if (isMac) window.removeEventListener("resize", apply);
    };
  }, [transparent, nativeBlurRadius]);

  useLayoutEffect(() => {
    const theme = themeById(themeId);
    const root = document.documentElement;
    const chrome = deriveChrome(theme.terminal, theme.appearance);
    const vars = chromeToCssVars(chrome);
    root.style.setProperty("--opaque-bg", chrome.bg);
    root.style.setProperty("--opaque-surface", chrome.surface);
    root.style.setProperty("--opaque-surface-alt", chrome.surfaceAlt);
    root.style.setProperty("--terminal-bg", transparent ? "transparent" : theme.terminal.background);
    root.style.setProperty("--surface-blur", `${options.blur}px`);
    root.style.setProperty("--surface-saturation", `${options.saturation}%`);
    root.style.setProperty("--app-bg", transparent ? `color-mix(in srgb, ${chrome.bg} ${options.opacity}%, transparent)` : chrome.bg);
    const opacity = options.surfaceOpacity / 100;
    const alpha: Record<string, number> = { "--bg": opacity, "--surface": opacity, "--surface-alt": Math.min(1, opacity + 0.06) };
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, transparent && alpha[key] ? `color-mix(in srgb, ${value} ${alpha[key] * 100}%, transparent)` : value);
    }
    root.style.colorScheme = theme.appearance;
    root.dataset.appearance = theme.appearance;
    root.dataset.transparency = transparent ? "on" : "off";
    root.dataset.native = String(HAS_TAURI);
  }, [themeId, transparent, options]);

  return <>{children}</>;
}
