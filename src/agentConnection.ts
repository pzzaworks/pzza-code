interface AgentCredentials { token: string; instance: string }
interface ConnectionOptions {
  credentials: () => Promise<AgentCredentials>;
  health: () => Promise<unknown>;
  pause: () => Promise<void>;
}

export function createAgentConnection({ credentials, health, pause }: ConnectionOptions) {
  let token = "";
  let pending: Promise<string> | undefined;
  let generation = 0;
  const verify = async (attemptGeneration: number) => {
    const expected = await credentials();
    if (!expected.token || !expected.instance) throw new Error("The local agent is not ready yet. Retry in a moment.");
    for (let attempt = 0; attempt < 30; attempt++) {
      let value: unknown;
      try { value = await health(); } catch { /* The agent may be restarting. */ }
      if (value && typeof value === "object" && "id" in value && value.id === expected.instance) {
        if (generation !== attemptGeneration) throw new Error("The local agent connection changed. Retry in a moment.");
        token = expected.token;
        return token;
      }
      if (attempt < 29) await pause();
    }
    throw new Error("The local agent is unavailable or its port is occupied. Retry in a moment.");
  };
  return {
    token: () => token,
    invalidate: () => { token = ""; generation++; },
    ready: (): Promise<string> => {
      if (token) return Promise.resolve(token);
      if (!pending) {
        pending = verify(generation).finally(() => { pending = undefined; });
      }
      return pending;
    },
  };
}
