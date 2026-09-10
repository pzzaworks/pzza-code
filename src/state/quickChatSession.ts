export interface ChatSession {
  session: string;
  host: string;
  // The saved profile owns a managed session, while launcher says what was
  // actually invoked to start it.
  agent: "claude" | "codex";
  launcher: "claude" | "codex" | "pz";
  identity: string;
}

// Startup reuses the device's managed conversation. Hiding, mounting twice, or
// losing a transport must never turn into a close/open cycle.
export function createQuickChatPreparation(
  open: (host: string, agent: ChatSession["agent"]) => Promise<ChatSession>,
): (host: string, agent: ChatSession["agent"]) => Promise<ChatSession> {
  const prepared = new Map<string, Promise<ChatSession>>();
  return (host, agent) => {
    const key = JSON.stringify([host, agent]);
    let request = prepared.get(key);
    if (!request) {
      request = open(host, agent).catch((error: unknown) => {
        prepared.delete(key);
        throw error;
      });
      prepared.set(key, request);
    }
    return request;
  };
}

export interface AttachmentStatus {
  phase: "connecting" | "connected" | "retrying" | "disconnected";
  attempt: number;
  message: string;
  delayMs?: number;
}

interface RecoveryOptions {
  verify: (signal: AbortSignal) => Promise<void>;
  attach: (signal: AbortSignal) => Promise<void>;
  detach: () => void;
  status: (status: AttachmentStatus) => void;
  random?: () => number;
  schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  unschedule?: (timer: ReturnType<typeof setTimeout>) => void;
}

// Only attachment is retried, never input or conversation creation. Epoch and
// abort checks also fence late verification/spawn completions after shutdown.
export function createAttachmentRecovery(options: RecoveryOptions) {
  const schedule = options.schedule ?? setTimeout;
  const unschedule = options.unschedule ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let stopped = false;
  let attempt = 0;
  let connected = false;
  const clear = () => {
    if (timer !== undefined) unschedule(timer);
    if (stableTimer !== undefined) unschedule(stableTimer);
    timer = stableTimer = undefined;
  };
  const failed = (message = "Connection lost.") => {
    if (stopped || controller?.signal.aborted) return;
    clear();
    controller?.abort();
    connected = false;
    options.detach();
    if (attempt >= 6) {
      options.status({ phase: "disconnected", attempt, message: `${message} Automatic retries paused. Retry when the device is available.` });
      return;
    }
    const delayMs = Math.round(Math.min(10000, 500 * 2 ** Math.max(0, attempt - 1)) * (0.8 + (options.random ?? Math.random)() * 0.4));
    options.status({ phase: "retrying", attempt, delayMs, message });
    timer = schedule(() => { void connect(); }, delayMs);
  };
  const connect = async () => {
    if (stopped) return;
    clear();
    controller?.abort();
    const current = new AbortController();
    controller = current;
    attempt++;
    options.status({ phase: attempt === 1 ? "connecting" : "retrying", attempt, message: "Verifying your existing conversation…" });
    timer = schedule(() => failed("The device did not finish attaching in time."), 25000);
    try {
      await options.verify(current.signal);
      if (stopped || current.signal.aborted) return;
      await options.attach(current.signal);
    } catch (error: unknown) {
      if (!stopped && !current.signal.aborted) failed(error instanceof Error ? error.message : "Could not reattach your conversation.");
    }
  };
  return {
    start: () => { void connect(); },
    ready: () => {
      if (stopped || controller?.signal.aborted || connected) return;
      connected = true;
      clear();
      options.status({ phase: "connected", attempt, message: "Connected" });
      // A socket that immediately closes is not a successful recovery. Prevent
      // a failing SSH process from resetting the retry budget on its error text.
      stableTimer = schedule(() => { attempt = 0; }, 15000);
    },
    failed,
    retry: () => {
      stopped = false;
      clear();
      controller?.abort();
      connected = false;
      options.detach();
      attempt = 0;
      void connect();
    },
    stop: () => {
      stopped = true;
      clear();
      controller?.abort();
      options.detach();
      options.status({ phase: "disconnected", attempt, message: "Reconnection stopped. Your conversation remains on its device." });
    },
  };
}
