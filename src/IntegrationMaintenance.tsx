import { useEffect } from "react";
import { deviceHost } from "./devices";
import { useStore } from "./state/store";
import { useIntegrationHealth } from "./state/integrationHealth";

export function IntegrationMaintenance() {
  const devices = useStore(state => state.devices);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(3, devices.length) }, async () => {
        while (!cancelled && index < devices.length) {
          const device = devices[index++];
          await useIntegrationHealth.getState().check(deviceHost(device), device.name);
        }
      }));
    };
    void check();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void check(); }, 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [devices]);
  return null;
}
