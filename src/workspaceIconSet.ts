import { icons } from "lucide-react";
import type { IconType } from "./sessionMeta";
import { registerFullIconSet } from "./workspaceIcons";

// The full lucide set (~1800 icons), keyed by PascalCase name. Its own chunk:
// see workspaceIcons. Casting here so icons can be looked up by name without
// fighting lucide's strict typing.
const ICONS = icons as unknown as Record<string, IconType>;
registerFullIconSet(ICONS);

// All lucide icon names, for search.
export const ALL_ICON_NAMES = Object.keys(ICONS);
