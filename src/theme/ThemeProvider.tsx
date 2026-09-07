import { useEffect } from "react";
import { useStore } from "../state/store";
import { HAS_TAURI } from "../tauriEnv";
import { setNativeTransparency } from "../nativeAppearance";
import { themeById } from "./themes";
import { chromeToCssVars, deriveChrome } from "./types";

// The app uses a single locked look with a neutral grey accent (theme switching
// was removed). Chrome is derived from the base terminal palette, then the
// accent is overridden to grey.
const GREY_ACCENT = "#454a54";
const GREY_ACCENT_TEXT = "#ffffff";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const themeId = useStore((s) => s.themeId);
  const transparent = useStore((s) => s.semiTransparent);
  const options = useStore((s) => s.transparencyOptions);
  const nativeBlur = transparent && options.blur > 0;

  useEffect(() => {
    let alive = true;
    if (!HAS_TAURI) {
      useStore.getState().setTransparencyNotice(transparent ? "In the browser, blur applies inside the page. Desktop blur is available in the supported desktop app." : null);
      return;
    }
    void setNativeTransparency(transparent, nativeBlur).then((result) => {
      if (alive) useStore.getState().setTransparencyNotice(result.reason ?? null);
    }).catch(() => {
      if (alive) useStore.getState().setTransparencyNotice("Desktop blur is unavailable. Translucent app surfaces are still enabled.");
    });
    return () => { alive = false; };
  }, [transparent, nativeBlur]);

  useEffect(() => {
    const theme = themeById(themeId);
    const root = document.documentElement;
    const chrome = deriveChrome(theme.terminal, theme.appearance);
    const vars = chromeToCssVars({
      ...chrome,
      accent: GREY_ACCENT,
      accentText: GREY_ACCENT_TEXT,
    });
    root.style.setProperty("--opaque-bg", chrome.bg);
    root.style.setProperty("--terminal-bg", transparent ? "transparent" : theme.terminal.background);
    root.style.setProperty("--surface-blur", `${options.blur}px`);
    root.style.setProperty("--surface-saturation", `${options.saturation}%`);
    const opacity = options.opacity / 100;
    const alpha: Record<string, number> = { "--bg": opacity, "--surface": Math.min(0.98, opacity + 0.16), "--surface-alt": Math.min(0.98, opacity + 0.2) };
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, transparent && alpha[key] ? `color-mix(in srgb, ${value} ${alpha[key] * 100}%, transparent)` : value);
    }
    root.dataset.appearance = theme.appearance;
    root.dataset.transparency = transparent ? "on" : "off";
    root.dataset.native = String(HAS_TAURI);
  }, [themeId, transparent, options]);

  return <>{children}</>;
}
