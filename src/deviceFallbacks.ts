import { useStore } from "./state/store";
import type { Device } from "./devices";
import { releaseDisabledQuickChatDevice } from "./panels/QuickChat";
import { releaseDisabledForwardDevices } from "./panels/PortsMenu";
import { releaseDisabledRdpServer } from "./panels/RdpMenu";

// Saved device choices (Quick Chat, forwarding, remote desktop) must never keep
// pointing at a disabled device: each one falls back as soon as it is disabled,
// and once at startup for devices disabled in an earlier run.
function release(devices: Device[]): void {
  releaseDisabledQuickChatDevice(devices);
  releaseDisabledForwardDevices(devices);
  releaseDisabledRdpServer(devices);
}

export function watchDisabledDevices(): () => void {
  release(useStore.getState().devices);
  return useStore.subscribe((state, previous) => {
    if (state.devices !== previous.devices) release(state.devices);
  });
}
