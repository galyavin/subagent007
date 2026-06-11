import { spawn } from "node:child_process";
import { DEFAULT_HEARTBEAT_INTERVAL_MS, type HeartbeatNotify } from "./progress.js";
import type { TimeoutBudget } from "./timeoutBudget.js";
import type { RunStopReason } from "./types.js";

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
  onOutputLine?: (line: string) => void | Promise<void>;
}

interface ProcessRunResult {
  combinedOutput: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  stopReason: RunStopReason;
  durationMs: number;
}

function timeoutMarker(budget: TimeoutBudget): string {
  return [
    "",
    `[subagent007 timeout] requested_timeout_ms=${budget.requestedTimeoutMs} resolved_timeout_ms=${budget.resolvedTimeoutMs} timeout_floor_ms=${budget.minRequestedTimeoutMs} effective_timeout_ms=${budget.effectiveTimeoutMs} timeout_headroom_ms=${budget.responseHeadroomMs} kill_grace_ms=${budget.killGraceMs} force_grace_ms=${budget.forceGraceMs}`,
    "",
  ].join("\n");
}

export function runChildProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  const startedAt = Date.now();
  const chunks: Buffer[] = [];
  let pendingLine = "";

  const emitOutputLine = (line: string) => {
    if (!options.onOutputLine) {
      return;
    }
    try {
      void Promise.resolve(options.onOutputLine(line)).catch(() => {
        // Active output projection is best-effort and must not affect the child process.
      });
    } catch {
      // Active output projection is best-effort and must not affect the child process.
    }
  };

  const collectChunk = (chunk: Buffer) => {
    chunks.push(chunk);
    pendingLine += chunk.toString("utf8");
    const lines = pendingLine.split(/\r?\n/);
    pendingLine = lines.pop() ?? "";
    for (const line of lines) {
      emitOutputLine(line);
    }
  };

  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let cancelled = false;
    let closed = false;
    let settled = false;
    let spawnError: Error | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    let forceTimeout: NodeJS.Timeout | undefined;
    let heartbeatInterval: NodeJS.Timeout | undefined;
    let heartbeatBeat = 0;
    let heartbeatInFlight = false;
    let abortListener: (() => void) | undefined;

    const clearTimers = () => {
      for (const timer of [timeout, killTimeout, forceTimeout, heartbeatInterval]) {
        if (timer) {
          clearTimeout(timer);
        }
      }
      if (abortListener) {
        options.abortSignal?.removeEventListener("abort", abortListener);
      }
    };

    const sendHeartbeat = () => {
      if (!options.heartbeat || heartbeatInFlight) {
        return;
      }
      heartbeatInFlight = true;
      heartbeatBeat += 1;
      const beat = heartbeatBeat;
      try {
        void (async () => {
          try {
            const message = await options.heartbeat?.message?.(beat);
            await options.heartbeat?.notify(beat, message);
          } catch {
            // Progress notifications are best-effort and must not affect the child process.
          } finally {
            heartbeatInFlight = false;
          }
        })();
      } catch {
        heartbeatInFlight = false;
      }
    };

    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      const stopReason: RunStopReason = spawnError
        ? "spawn_error"
        : timedOut
          ? "timeout"
          : cancelled
            ? "cancelled"
            : exitCode === 0
              ? "completed"
              : "failed";
      resolve({
        combinedOutput: Buffer.concat(chunks).toString("utf8"),
        exitCode: spawnError ? null : exitCode,
        timedOut,
        cancelled,
        stopReason,
        durationMs: Date.now() - startedAt,
      });
    };

    const signalChild = (signal: NodeJS.Signals) => {
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

    if (options.timeoutBudget.effectiveTimeoutMs !== null) {
      timeout = setTimeout(() => {
        timedOut = true;
        const marker = timeoutMarker(options.timeoutBudget);
        chunks.push(Buffer.from(marker));
        for (const line of marker.split(/\r?\n/)) {
          emitOutputLine(line);
        }
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
        }, options.timeoutBudget.killGraceMs + options.timeoutBudget.forceGraceMs);
      }, options.timeoutBudget.effectiveTimeoutMs);
    }

    abortListener = () => {
      if (settled || closed) {
        return;
      }
      cancelled = true;
      const marker = "\n[subagent007 cancelled]\n";
      chunks.push(Buffer.from(marker));
      for (const line of marker.split(/\r?\n/)) {
        emitOutputLine(line);
      }
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
      }, options.timeoutBudget.killGraceMs + options.timeoutBudget.forceGraceMs);
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

    child.stdout.on("data", collectChunk);
    child.stderr.on("data", collectChunk);
    child.on("error", (error) => {
      spawnError = error;
      chunks.push(Buffer.from(`\n[spawn error] ${error.message}\n`));
    });
    child.on("close", (code) => {
      closed = true;
      if (pendingLine.trim() !== "") {
        emitOutputLine(pendingLine);
      }
      finish(code);
    });
  });
}
