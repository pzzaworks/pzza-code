import { useMemo } from "react";
import { create } from "zustand";
import { useStore } from "../state/store";
import { themeById } from "./themes";
import type { Theme } from "./types";

// A theme shown before it is chosen: the one highlighted in the theme list,
// until the list closes.
export const useThemePreview = create<{ id: string | null }>(() => ({ id: null }));

/** The theme the app shows: a previewed one while the theme list has one highlighted, else the selected theme. */
export function useActiveTheme(): Theme {
  const themeId = useStore((state) => state.themeId);
  const previewId = useThemePreview((state) => state.id);
  return useMemo(() => themeById(previewId ?? themeId), [previewId, themeId]);
}
