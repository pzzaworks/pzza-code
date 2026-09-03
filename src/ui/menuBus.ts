import { useEffect } from "react";

// Simple exclusivity bus: opening one menu closes the others.
export function announceMenu(id: string) {
  window.dispatchEvent(new CustomEvent("pzza-menu", { detail: id }));
}

export function useExclusiveMenu(id: string, open: boolean, close: () => void) {
  useEffect(() => {
    const h = (e: Event) => {
      if ((e as CustomEvent).detail !== id) close();
    };
    window.addEventListener("pzza-menu", h as EventListener);
    return () => window.removeEventListener("pzza-menu", h as EventListener);
  }, [id, close]);

  useEffect(() => {
    if (open) announceMenu(id);
  }, [open, id]);
}
