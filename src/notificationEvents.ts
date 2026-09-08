import { useEffect } from "react";
import { fetchBridgeJobs } from "./bridgeApi";
import { notify, useNotifications } from "./state/notifications";

export function useBridgeNotifications() {
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let previous: Map<string, string> | null = null;
    const poll = async () => {
      const { preferences } = useNotifications.getState();
      if (preferences.enabled && preferences.categories.bridge) {
        try {
          const { jobs } = await fetchBridgeJobs();
          if (stopped) return;
          for (const job of jobs) {
            if (previous?.get(job.id) === job.status) continue;
            if (!previous && job.status !== "waiting_approval") continue;
            if (!["waiting_approval", "completed", "failed", "cancelled", "interrupted"].includes(job.status)) continue;
            notify({ category: "bridge", event: job.status === "waiting_approval" ? "bridge-approval" : "bridge-result", title: job.status === "waiting_approval" ? "Bridge approval required" : `Bridge job ${job.status}`, body: "Open MCP & connections to review the job details.", target: { section: "mcp" }, dedupeKey: `bridge:${job.id}:${job.status}` });
          }
          previous = new Map(jobs.map(job => [job.id, job.status]));
        } catch { /* Offline agents are retried without generating repeated alerts. */ }
      }
      if (!stopped) timer = setTimeout(() => void poll(), 10000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
}
