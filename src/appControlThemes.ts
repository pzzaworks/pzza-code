import { registerAppControlHandler } from "./appControlRuntime";
import { useStore } from "./state/store";
import { allThemes } from "./theme/themes";

// The app command for reading themes; configure_appearance sets one.

/** Whether every word of the query is in the theme name. */
function matches(name: string, query: string): boolean {
  const lower = name.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => lower.includes(word));
}

export function initThemeAppControlHandlers(): () => void {
  return registerAppControlHandler("list_themes", (args) => {
    const query = typeof args.query === "string" ? args.query : "";
    const appearance = args.appearance;
    const themes = allThemes().filter((theme) => (!query || matches(theme.name, query)) && (appearance === undefined || theme.appearance === appearance));
    return {
      active: useStore.getState().themeId,
      count: themes.length,
      themes: themes.map((theme) => ({ id: theme.id, name: theme.name, appearance: theme.appearance })),
    };
  });
}
