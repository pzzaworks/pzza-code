import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ALL_ICON_NAMES, CURATED_ICONS, workspaceIcon } from "../workspaceIcons";

// Icon picker with a search box over the full lucide set (~1800 icons). Without
// a query it shows a curated default list; typing filters every icon by name.
export function IconPicker({
  value,
  onSelect,
}: {
  value?: string;
  onSelect: (name: string) => void;
}) {
  const [q, setQ] = useState("");
  const names = useMemo(() => {
    const query = q.trim().toLowerCase();
    const base = query
      ? ALL_ICON_NAMES.filter((n) => n.toLowerCase().includes(query)).slice(0, 200)
      : CURATED_ICONS;
    return [...new Set(base)];
  }, [q]);

  return (
    <div className="icon-picker">
      <div className="icon-search">
        <Search size={13} className="icon-search-glyph" />
        <input
          className="icon-search-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search icons..."
          spellCheck={false}
          autoFocus
        />
      </div>
      <div className="icon-grid">
        {names.map((name) => {
          const Icon = workspaceIcon(name);
          return (
            <button
              key={name}
              type="button"
              className={`icon-choice ${value === name ? "icon-choice-on" : ""}`}
              onClick={() => onSelect(name)}
              title={name}
            >
              <Icon size={16} />
            </button>
          );
        })}
        {names.length === 0 ? <div className="icon-empty">No icons found</div> : null}
      </div>
    </div>
  );
}
