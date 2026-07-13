import { parentPort } from "node:worker_threads";
import { appendFailureRecord } from "./failureStorage.js";

interface FailureWriteJob { logPath: string; line: string }
let chain = Promise.resolve();
let idleTimer: NodeJS.Timeout | undefined;

parentPort?.on("message", (job: FailureWriteJob) => {
  if (idleTimer) clearTimeout(idleTimer);
  chain = chain.then(async () => {
    try { await appendFailureRecord(job.logPath, job.line); } catch { /* best effort */ }
    parentPort?.postMessage("done");
    idleTimer = setTimeout(() => parentPort?.close(), 100);
  });
});
