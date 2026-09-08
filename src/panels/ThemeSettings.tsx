import { Check, Moon, Sun } from "lucide-react";
import { BUILTIN_THEMES } from "../theme/themes";
import { useStore } from "../state/store";

export function ThemeSettings() {
  const themeId = useStore(state => state.themeId);
  const setTheme = useStore(state => state.setTheme);
  return <div className="theme-settings">
    <div className="appearance-modes" role="group" aria-label="Appearance">
      {BUILTIN_THEMES.map(theme => {
        const Icon = theme.appearance === "dark" ? Moon : Sun;
        return <button type="button" key={theme.id} className={`appearance-option ${theme.appearance} ${theme.id === themeId ? "selected" : ""}`}
          aria-pressed={theme.id === themeId} onClick={() => setTheme(theme.id)}>
          <span className="appearance-preview" aria-hidden="true"><span className="appearance-preview-nav"><i /><i /><i /></span><span className="appearance-preview-body"><i /><i /><i /></span></span>
          <span className="appearance-option-label"><Icon size={14} />{theme.name}{theme.id === themeId ? <Check size={14} /> : null}</span>
        </button>;
      })}
    </div>
  </div>;
}
