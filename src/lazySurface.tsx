import { createElement, Suspense, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { ErrorBoundary, SurfaceLoadError, type ErrorBoundaryVariant } from "./ui/ErrorBoundary";

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

// Each surface renders inside its own error boundary, so one that fails to
// render shows a short note with Try again in its place (Reload when its code
// could not be loaded), or a dialog for window-level surfaces that shows again
// when they reopen, instead of taking the whole window down.
export interface SurfaceBoundary<P extends object = object> {
  /** What the surface is, as the subject of a sentence (see ErrorBoundary). */
  label?: string;
  variant?: ErrorBoundaryVariant;
  /** Where its note sits, so it takes the surface's own place. */
  className?: string;
  /** dialog: closes the surface when its error dialog is closed, so it can be opened again. */
  dismiss?: (props: P) => void;
}

export function lazySurface<P extends object>(load: () => Promise<ComponentType<P>>, fallback: ReactNode = null, { label = "This panel", variant = "panel", className, dismiss }: SurfaceBoundary<P> = {}): LazySurface<P> {
  let loaded: ComponentType<P> | null = null;
  let loading: Promise<ComponentType<P>> | null = null;
  let failure: { error: unknown } | null = null;
  // A new attempt (a preload, or a retry) starts over after a failed load.
  const fetch = () => (loading ??= (failure = null, load()).then(
    (component) => (loaded = component),
    (error: unknown) => { loading = null; failure = { error: new SurfaceLoadError(error) }; throw error; },
  ));
  // Suspends (throws the pending load to the Suspense boundary) until loaded;
  // a failed load throws its error, as React.lazy does. The failure stays
  // until a retry asks for another load: React renders a failed part more
  // than once before showing its boundary, and must see the same error.
  function Deferred(props: P) {
    if (loaded) return createElement(loaded, props);
    if (failure) throw failure.error;
    throw fetch();
  }
  const retry = () => { failure = null; };
  function Surface(props: P) {
    const resetKey = "open" in props ? props.open : undefined;
    const onDismiss = dismiss ? () => dismiss(props) : undefined;
    return createElement(ErrorBoundary, { label, variant, className, resetKey, onRetry: retry, onDismiss }, createElement(Suspense, { fallback }, createElement(Deferred, props)));
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
