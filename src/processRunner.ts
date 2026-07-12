import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fsp from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { DEFAULT_HEARTBEAT_INTERVAL_MS, type HeartbeatNotify } from "./progress.js";
import type { TimeoutBudget } from "./timeoutBudget.js";
import type { RunStopReason } from "./types.js";

export interface DiskReserveGuard {
  path: string;
  minimumFreeBytes: number;
  checkIntervalMs: number;
}

interface ProcessRunOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutBudget: TimeoutBudget;
  abortSignal?: AbortSignal;
  heartbeat?: {
    intervalMs?: number;
    message?: (beat: number) => string | undefined | Promise<string | undefined>;
    notify: HeartbeatNotify;
  };
  diskReserve?: DiskReserveGuard;
  onOutputLine?: (line: string) => void | Promise<void>;
  onControlReady?: (send: (message: string) => boolean) => void;
}

interface ProcessRunResult {
  exitCode: number | null;
  stopSignal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  resourceExhausted: boolean;
  stopReason: RunStopReason;
  durationMs: number;
}

function timeoutMarker(budget: TimeoutBudget): string {
  return `[subagent007 timeout] requested_timeout_ms=${budget.requestedTimeoutMs} resolved_timeout_ms=${budget.resolvedTimeoutMs} timeout_floor_ms=${budget.minRequestedTimeoutMs} effective_timeout_ms=${budget.effectiveTimeoutMs} timeout_headroom_ms=${budget.responseHeadroomMs} kill_grace_ms=${budget.killGraceMs} force_grace_ms=${budget.forceGraceMs}`;
}

export async function availableDiskBytes(filePath: string): Promise<number> {
  const stats = await fsp.statfs(filePath);
  return Number(stats.bavail) * Number(stats.bsize);
}

function isDiskExhaustionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOSPC" || code === "EDQUOT";
}

export async function runChildProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin.on("error", () => {
      // The child terminal path, not the control pipe, owns run settlement.
    });
    options.onControlReady?.((message) => {
      if (child.stdin.destroyed || !child.stdin.writable) {
        return false;
      }
      try {
        child.stdin.write(message);
        return true;
      } catch {
        return false;
      }
    });

    let timedOut = false;
    let cancelled = false;
    let resourceExhausted = false;
    let closed = false;
    let settled = false;
    let spawnError: Error | undefined;
    let outputError: Error | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    let forceTimeout: NodeJS.Timeout | undefined;
    let heartbeatInterval: NodeJS.Timeout | undefined;
    let diskInterval: NodeJS.Timeout | undefined;
    let heartbeatBeat = 0;
    let heartbeatInFlight = false;
    let diskCheckInFlight = false;
    let abortListener: (() => void) | undefined;
    let cleanupOnParentExit: (() => void) | undefined;
    let terminationStarted = false;
    let lastSignalSent: NodeJS.Signals | null = null;
    let outputChain: Promise<void> = Promise.resolve();
    const forceFinishDelayMs = options.timeoutBudget.killGraceMs + options.timeoutBudget.forceGraceMs;

    const clearTimers = () => {
      for (const timer of [timeout, killTimeout, forceTimeout, heartbeatInterval, diskInterval]) {
        if (timer) {
          clearTimeout(timer);
        }
      }
      if (abortListener) {
        options.abortSignal?.removeEventListener("abort", abortListener);
      }
      if (cleanupOnParentExit) {
        process.removeListener("exit", cleanupOnParentExit);
      }
    };

    const signalChild = (signal: NodeJS.Signals) => {
      lastSignalSent = signal;
      if (!child.pid) {
        return;
      }
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            child.kill(signal);
          }
          return;
        }
      }
      child.kill(signal);
    };

    const finish = (exitCode: number | null, stopSignal: NodeJS.Signals | null = lastSignalSent) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      const stopReason: RunStopReason = spawnError
        ? "spawn_error"
        : resourceExhausted
          ? "resource_exhausted"
          : timedOut
            ? "timeout"
            : cancelled
              ? "cancelled"
              : exitCode === 0 && !outputError
                ? "completed"
                : "failed";
      const result: ProcessRunResult = {
        exitCode: spawnError ? null : exitCode,
        stopSignal: spawnError ? null : stopSignal,
        timedOut,
        cancelled,
        resourceExhausted,
        stopReason,
        durationMs: Date.now() - startedAt,
      };
      void outputChain.finally(() => resolve(result));
    };

    const startGracefulTermination = () => {
      if (terminationStarted) {
        return;
      }
      terminationStarted = true;
      signalChild("SIGTERM");
      killTimeout = setTimeout(() => {
        if (!closed) {
          signalChild("SIGKILL");
        }
      }, options.timeoutBudget.killGraceMs);
      forceTimeout = setTimeout(() => {
        if (!closed) {
          finish(null);
        }
      }, forceFinishDelayMs);
    };

    const queueOutputLine = (line: string): Promise<void> => {
      const operation = outputChain.then(async () => {
        await options.onOutputLine?.(line);
      });
      outputChain = operation.catch((error: unknown) => {
        outputError ??= error instanceof Error ? error : new Error(String(error));
        if (isDiskExhaustionError(error)) {
          resourceExhausted = true;
        }
        startGracefulTermination();
      });
      return operation;
    };

    const appendControlMarker = (marker: string) => {
      void queueOutputLine(marker).catch(() => {
        // A failed transcript write already triggers child termination above.
      });
    };

    const consumeStream = async (stream: ChildProcessWithoutNullStreams["stdout"]): Promise<void> => {
      const decoder = new StringDecoder("utf8");
      let pendingLine = "";
      for await (const chunk of stream) {
        pendingLine += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const lines = pendingLine.split(/\r?\n/);
        pendingLine = lines.pop() ?? "";
        for (const line of lines) {
          await queueOutputLine(line);
        }
      }
      pendingLine += decoder.end();
      if (pendingLine.trim() !== "") {
        await queueOutputLine(pendingLine);
      }
    };

    const sendHeartbeat = () => {
      if (!options.heartbeat || heartbeatInFlight) {
        return;
      }
      heartbeatInFlight = true;
      heartbeatBeat += 1;
      const beat = heartbeatBeat;
      void (async () => {
        try {
          const message = await options.heartbeat?.message?.(beat);
          await options.heartbeat?.notify(beat, message);
        } catch {
          // Progress notifications are best-effort.
        } finally {
          heartbeatInFlight = false;
        }
      })();
    };

    const checkDiskReserve = () => {
      if (!options.diskReserve || diskCheckInFlight || settled || resourceExhausted) {
        return;
      }
      diskCheckInFlight = true;
      void (async () => {
        try {
          const freeBytes = await availableDiskBytes(options.diskReserve!.path);
          if (freeBytes < options.diskReserve!.minimumFreeBytes) {
            resourceExhausted = true;
            appendControlMarker(
              `[subagent007 disk reserve exhausted] available_bytes=${freeBytes} minimum_free_bytes=${options.diskReserve!.minimumFreeBytes}`,
            );
            startGracefulTermination();
          }
        } catch (error) {
          outputError ??= error instanceof Error ? error : new Error(String(error));
          startGracefulTermination();
        } finally {
          diskCheckInFlight = false;
        }
      })();
    };

    cleanupOnParentExit = () => {
      if (!settled && !closed) {
        signalChild("SIGKILL");
      }
    };
    process.once("exit", cleanupOnParentExit);

    if (options.timeoutBudget.effectiveTimeoutMs !== null) {
      timeout = setTimeout(() => {
        timedOut = true;
        appendControlMarker(timeoutMarker(options.timeoutBudget));
        startGracefulTermination();
      }, options.timeoutBudget.effectiveTimeoutMs);
    }

    abortListener = () => {
      if (settled || closed) {
        return;
      }
      cancelled = true;
      appendControlMarker("[subagent007 cancelled]");
      startGracefulTermination();
    };
    if (options.abortSignal?.aborted) {
      abortListener();
    } else {
      options.abortSignal?.addEventListener("abort", abortListener, { once: true });
    }

    if (options.heartbeat) {
      heartbeatInterval = setInterval(
        sendHeartbeat,
        options.heartbeat.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      );
    }
    if (options.diskReserve) {
      diskInterval = setInterval(checkDiskReserve, options.diskReserve.checkIntervalMs);
      checkDiskReserve();
    }

    const consumers = Promise.all([
      consumeStream(child.stdout),
      consumeStream(child.stderr),
    ]).catch((error: unknown) => {
      outputError ??= error instanceof Error ? error : new Error(String(error));
      if (isDiskExhaustionError(error)) {
        resourceExhausted = true;
      }
      startGracefulTermination();
    });

    child.on("error", (error) => {
      spawnError = error;
      appendControlMarker(`[spawn error] ${error.message}`);
    });
    child.on("close", (code, signal) => {
      closed = true;
      void consumers.finally(() => finish(code, signal));
    });
  });
}
