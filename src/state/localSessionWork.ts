// Whether a local session refresh or restore is running right now. The app
// itself must never end in the middle of one (quit, window close, Restart to
// update, app-control close and relaunch): the terminal server may already
// be restarted with sessions and agents not back yet. Exits wait for it here.
// Kept free of the session modules so the updater can use it on its own;
// main.tsx connects it to the refresh state (see sessionRefresh).

interface WorkState { running: boolean }
interface WorkSource {
  getState(): WorkState;
  subscribe(listener: (state: WorkState) => void): () => void;
}

let source: WorkSource | null = null;

export function watchLocalSessionWork(next: WorkSource): void {
  source = next;
}

export function localSessionWorkRunning(): boolean {
  return source?.getState().running ?? false;
}

/** Resolves once no local session refresh or restore is running. */
export function whenLocalSessionWorkSettled(): Promise<void> {
  const current = source;
  if (!current || !current.getState().running) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = current.subscribe((state) => {
      if (state.running) return;
      stop();
      resolve();
    });
  });
}
