import { createDeviceReadCache } from "../deviceReadCache";
import { fetchPaneOutputActivity, type PaneOutputActivity } from "../serverApi";

// Shared per-device output-activity readings. The checkpoint turn watch, the
// hidden-tile dots and the task tracker each poll this every few seconds on
// their own timers; reading through one cache sends one request per device
// per cycle instead of one per feature.

/**
 * The oldest reading a periodic (4 s) poller reuses: just under its interval,
 * so each cycle still reads the device once while the other pollers in that
 * cycle share the answer.
 */
export const OUTPUT_ACTIVITY_SHARE_MS = 3500;

export const readPaneOutputActivity = createDeviceReadCache<PaneOutputActivity[]>(fetchPaneOutputActivity);
