interface ChatSession {
  session: string;
  host: string;
  agent: "claude" | "codex";
}

// A launch owns one fresh conversation even when multiple effects request it.
export function createQuickChatPreparation(
  open: (host: string, agent: ChatSession["agent"]) => Promise<ChatSession>,
  close: (host: string) => Promise<void>,
): (host: string, agent: ChatSession["agent"]) => Promise<ChatSession> {
  let prepared: Promise<ChatSession> | undefined;
  return (host, agent) => {
    prepared ??= close(host).then(() => open(host, agent)).catch((error: unknown) => {
      prepared = undefined;
      throw error;
    });
    return prepared;
  };
}
