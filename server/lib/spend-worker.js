import { parentPort } from "node:worker_threads";
import { scanSpend } from "./spend-scan.js";

parentPort.on("message", async ({ now }) => {
  try {
    parentPort.postMessage({ data: await scanSpend(now) });
  } catch {
    // Do not expose transcript contents or local paths in errors.
    parentPort.postMessage({ error: "Unable to scan local usage" });
  }
});
