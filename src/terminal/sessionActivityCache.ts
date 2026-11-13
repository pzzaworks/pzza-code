import { createDeviceReadCache } from "../deviceReadCache";
import { fetchSessionActivity, type SessionActivity } from "../serverApi";

// Shared per-device session-activity readings for the live tile icons and the
// permission and task foreground checks, so their requests to one device
// coincide instead of stacking up.
export const readSessionActivity = createDeviceReadCache<SessionActivity[]>(fetchSessionActivity);
