import { registerAppControlHandler, registerAppControlState } from "./appControlRuntime";
import { useIntegrationHealth } from "./state/integrationHealth";
import { useMcpSettings } from "./state/mcpSettings";
import { useStore } from "./state/store";
import { deviceHost } from "./devices";

function snapshot() {
  const settings = useMcpSettings.getState();
  const health = useIntegrationHealth.getState();
  return { agentHost: settings.agentHost, mcpPath: settings.mcpPath, config: settings.config, loading: settings.loading, error: settings.error,
    installing: settings.busy, notes: settings.notes, batch: health.batch, devices: Object.values(health.devices) };
}
export function initIntegrationAppControlHandlers(): () => void {
  const handlers: Record<string, (args: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>> = {
    get_integrations: async () => { const settings = useMcpSettings.getState(); if (!settings.config && !settings.loading) await settings.load(); return snapshot(); },
    check_integrations: args => {
      const devices = useStore.getState().devices;
      const ids = args.deviceIds as string[] | undefined;
      if (ids?.some(id => !devices.some(device => device.id === id))) throw new Error("Select configured devices for integration checks.");
      const targets = devices.filter(device => !ids || ids.includes(device.id)).map(device => ({ host: deviceHost(device), name: device.name }));
      return { accepted: true, operation: useIntegrationHealth.getState().checkAll(targets, args.fresh !== false) };
    },
    configure_integration_connection: async args => {
      const settings = useMcpSettings.getState();
      if (settings.busy) throw new Error("Wait for the current integration installation before changing its target.");
      const host = (args.agentHost as string | undefined) ?? settings.agentHost;
      const path = (args.mcpPath as string | undefined) ?? settings.mcpPath;
      if (host && !path.startsWith("/")) throw new Error("A remote integration requires an absolute MCP script path.");
      settings.select({ agentHost: host, mcpPath: path });
      await settings.load();
      return snapshot();
    },
    install_integration: args => {
      const settings = useMcpSettings.getState();
      if (settings.busy) throw new Error("An integration installation is already running.");
      if (settings.agentHost) throw new Error("Copy the configuration into the remote client settings.");
      void settings.install(args.framework as string).catch(() => {});
      return { accepted: true, ...snapshot() };
    },
    copy_integration_config: async args => { await useMcpSettings.getState().copy(args.framework as string); return { copied: true }; },
  };
  const cleanups = Object.entries(handlers).map(([action, handler]) => registerAppControlHandler(action, handler));
  cleanups.push(registerAppControlState("integrations", snapshot));
  return () => { for (const cleanup of cleanups.reverse()) cleanup(); };
}
