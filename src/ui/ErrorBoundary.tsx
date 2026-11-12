import { Component, type ErrorInfo, type ReactNode } from "react";
import { Modal } from "./Modal";
import { confirmUnsavedWork } from "../state/unsavedWork";

export type ErrorBoundaryVariant = "screen" | "dialog" | "panel" | "quiet";

/**
 * A part's code could not be loaded. The webview keeps a failed module load
 * for the life of the page, so only a reload loads it again, not Try again.
 */
export class SurfaceLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Its code could not be loaded.");
    this.name = "SurfaceLoadError";
  }
}

interface Props {
  /** What is shown here, as the subject of a sentence: "Settings", "This terminal". */
  label: string;
  children?: ReactNode;
  /**
   * screen: the whole window broke; a calm dialog offers Try again and Reload.
   * dialog: a window-level surface (Settings, the palette) broke; a dialog
   *   offers Try again or Close, and it shows again when resetKey changes.
   * panel: only this part broke; it is replaced by a short note with Try again
   *   (Reload when its code could not be loaded).
   * quiet: a part that shows nothing, or only extras, broke; it stays out of sight.
   */
  variant?: ErrorBoundaryVariant;
  /** Where the panel note sits (defaults to a centered block that fills its box). */
  className?: string;
  /**
   * The surface's open state: a change renders the part again. After the
   * dialog was closed, only opening again (a truthy key) does.
   */
  resetKey?: unknown;
  /** Runs before the part renders again (a lazy surface clears its failed load). */
  onRetry?: () => void;
  /**
   * dialog: Close also closes the surface, so its owner no longer counts it
   * as open and opening it again renders it again.
   */
  onDismiss?: () => void;
}

interface State { error: Error | null; dismissed: boolean }

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(typeof value === "string" ? value : "Unknown error");
}

// Reloading drops what only lives in the page (editor buffers, settings
// drafts): it goes through the same unsaved-work check as quitting.
async function reloadWindow(): Promise<void> {
  if (await confirmUnsavedWork()) window.location.reload();
}

/**
 * Keeps a render error inside the part of the window it happened in. Without
 * it React unmounts the whole root and the window goes blank. Try again
 * renders the part once more: app state lives in the stores and in storage,
 * outside the broken tree, so nothing is lost by retrying. Terminals keep
 * running in tmux either way.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, dismissed: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: asError(error), dismissed: false };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`${this.props.label} could not be shown.`, error, info.componentStack);
  }

  componentDidUpdate(previous: Props): void {
    const { error, dismissed } = this.state;
    if (!error || previous.resetKey === this.props.resetKey) return;
    // Closed from its dialog, the part stays out of sight while the surface
    // is closed (a failed load would only fail again), and renders again
    // when it opens.
    if (dismissed && !this.props.resetKey) return;
    this.retry();
  }

  private retry = () => {
    this.props.onRetry?.();
    this.setState({ error: null, dismissed: false });
  };

  private dismiss = () => {
    this.setState({ dismissed: true });
    this.props.onDismiss?.();
  };

  render(): ReactNode {
    const { error, dismissed } = this.state;
    if (!error) return this.props.children;
    const { label, variant = "panel", className } = this.props;
    if (variant === "quiet" || dismissed) return null;
    const loadFailed = error instanceof SurfaceLoadError;
    const reload = () => void reloadWindow();
    if (variant === "screen" || variant === "dialog") {
      const screen = variant === "screen";
      return (
        <Modal open onClose={screen ? this.retry : this.dismiss} title="Something went wrong" size="sm" role="alertdialog">
          <p className="move-q">{label} hit an unexpected problem. Your terminals keep running and nothing was closed.</p>
          <p className="set-note">{error.message}</p>
          <div className="modal-actions">
            {screen ? null : <button type="button" className="btn" onClick={this.dismiss}>Close</button>}
            {loadFailed ? null : <button type="button" className={screen ? "btn" : "btn btn-accent"} onClick={this.retry}>Try again</button>}
            {screen || loadFailed ? <button type="button" className="btn btn-accent" onClick={reload}>Reload</button> : null}
          </div>
        </Modal>
      );
    }
    return (
      <div className={className ?? "grid-empty"} role="alert">
        <p className="set-note">{loadFailed ? `${label} could not be loaded. Reload PzzaCode to load it again; your terminals keep running.` : `${label} could not be shown.`}</p>
        {loadFailed
          ? <button type="button" className="btn btn-sm" onClick={reload}>Reload</button>
          : <button type="button" className="btn btn-sm" onClick={this.retry}>Try again</button>}
      </div>
    );
  }
}
