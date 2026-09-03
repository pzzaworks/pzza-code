import { useEffect } from "react";
import { useStore } from "../state/store";
import { themeById } from "./themes";
import { chromeToCssVars, deriveChrome } from "./types";

// The app uses a single locked look with a neutral grey accent (theme switching
// was removed). Chrome is derived from the base terminal palette, then the
// accent is overridden to grey.
const GREY_ACCENT = "#454a54";
const GREY_ACCENT_TEXT = "#ffffff";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const themeId = useStore((s) => s.themeId);

  useEffect(() => {
    const theme = themeById(themeId);
    const root = document.documentElement;
    const chrome = deriveChrome(theme.terminal, theme.appearance);
    const vars = chromeToCssVars({
      ...chrome,
      accent: GREY_ACCENT,
      accentText: GREY_ACCENT_TEXT,
    });
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value);
    }
    root.dataset.appearance = theme.appearance;
  }, [themeId]);

  return <>{children}</>;
}
