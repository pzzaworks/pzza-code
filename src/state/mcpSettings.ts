import { create } from "zustand";
import { fetchMcpConfig, mcpInstall, type McpConfig } from "../serverApi";

interface McpSettings {
  agentHost: string;
  mcpPath: string;
  config: McpConfig | null;
  error: string | null;
  loading: boolean;
  busy: string | null;
  notes: Record<string, string>;
  select(settings: { agentHost?: string; mcpPath?: string }): void;
  load(): Promise<McpConfig>;
  install(framework: string): Promise<void>;
  copy(framework: string): Promise<void>;
}
let request = 0;
export const useMcpSettings = create<McpSettings>((set, get) => ({
  agentHost: "", mcpPath: "", config: null, error: null, loading: false, busy: null, notes: {},
  select(settings) { request++; set({ ...settings, config: null, error: null, loading: false, notes: {} }); },
  async load() {
    const id = ++request;
    const { agentHost, mcpPath } = get();
    set({ loading: true, error: null });
    try {
      const config = await fetchMcpConfig(agentHost.trim(), mcpPath.trim());
      if (request === id) set({ config, error: null, loading: false });
      return config;
    } catch {
      if (request === id) set({ config: null, error: "Check the SSH host and MCP script path.", loading: false });
      throw new Error("Check the SSH host and MCP script path.");
    }
  },
  async install(framework) {
    if (get().busy) throw new Error("An integration installation is already running.");
    if (get().agentHost.trim()) throw new Error("Copy the generated configuration into the remote client settings.");
    set({ busy: framework });
    try {
      const result = await mcpInstall(framework);
      if (!result.ok) throw new Error(typeof result.error === "string" && result.error ? result.error : "Integration installation failed. Check the client executable and retry.");
      set(state => ({ notes: { ...state.notes, [framework]: result.unchanged ? "already added ✓" : "added ✓" } }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Integration installation failed. Check the client executable and retry.";
      set(state => ({ notes: { ...state.notes, [framework]: message } }));
      throw cause instanceof Error ? cause : new Error(message);
    } finally { set({ busy: null }); }
  },
  async copy(framework) {
    const id = request;
    const config = get().config ?? await get().load();
    if (get().config !== config || (id !== request && get().loading)) throw new Error("Configuration changed. Wait for it to reload before copying.");
    const entry = config.frameworks[framework];
    if (!entry) throw new Error("Unknown integration framework.");
    try {
      await navigator.clipboard.writeText(entry.config);
      set(state => ({ notes: { ...state.notes, [framework]: "copied ✓" } }));
    } catch {
      set(state => ({ notes: { ...state.notes, [framework]: "copy failed" } }));
      throw new Error("Could not copy the integration configuration.");
    }
  },
}));
