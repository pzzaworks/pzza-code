import { createElement, Suspense, useEffect, useState, type ComponentType, type ReactNode } from "react";

// A component whose code loads on first use, from its own chunk. preload()
// starts that load early (on intent, at startup when the first window needs it,
// or when idle). React.lazy suspends for at least one commit even when the
// module has already loaded; a surface whose code is loaded renders it in the
// same commit as its parent instead, so a preloaded surface never shows its
// fallback.
export interface LazySurface<P extends object> {
  (props: P): ReactNode;
  /** Loads the surface's code; never rejects (a failed load surfaces on render). */
  preload(): Promise<void>;
  isLoaded(): boolean;
}

export function lazySurface<P extends object>(load: () => Promise<ComponentType<P>>, fallback: ReactNode = null): LazySurface<P> {
  let loaded: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P>> | null = null;
  let failure: { error: unknown } | null = null;
  const fetch = () => (loading ??= load().then(
    (component) => (loaded = component),
    (error: unknown) => { loading = null; failure = { error }; throw error; },
  ));
  // Suspends (throws the pending load to the Suspense boundary) until loaded;
  // a failed load throws its error, as React.lazy does.
  function Deferred(props: P) {
    if (loaded) return createElement(loaded, props);
    if (failure) { const { error } = failure; failure = null; throw error; }
    throw fetch();
  }
  function Surface(props: P) {
    return createElement(Suspense, { fallback }, createElement(Deferred, props));
  }
  return Object.assign(Surface, {
    preload: () => fetch().then(() => undefined, () => undefined),
    isLoaded: () => loaded !== null,
  });
}

/** Runs `show` now when every surface is loaded, otherwise as soon as they are, so what it opens never renders a fallback. */
export function whenLoaded(surfaces: readonly LazySurface<never>[], show: () => void): void {
  if (surfaces.every((surface) => surface.isLoaded())) show();
  else void Promise.all(surfaces.map((surface) => surface.preload())).then(show);
}

/**
 * True from the first time `open` is true on. A surface that keeps state
 * between openings (a query, a form) mounts on first open and then stays
 * mounted, as it did when it was mounted from the start: closed, it renders
 * nothing.
 */
export function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}

/** Whether every surface is loaded; while `wanted`, loads them and re-renders once they are. */
export function useSurfacesLoaded(surfaces: readonly LazySurface<never>[], wanted: boolean): boolean {
  const [, setSettled] = useState(0);
  const ready = surfaces.every((surface) => surface.isLoaded());
  useEffect(() => {
    if (!wanted || ready) return;
    let alive = true;
    void Promise.all(surfaces.map((surface) => surface.preload())).then(() => { if (alive) setSettled((count) => count + 1); });
    return () => { alive = false; };
  }, [surfaces, wanted, ready]);
  return ready;
}
