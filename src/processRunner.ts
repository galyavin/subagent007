import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  outputPath: string;
  outputSizeBytes: number;
  exitCode: number | null;
  stopSignal: NodeJS.Signals | null;
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

export async function runChildProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  const startedAt = Date.now();
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), "subagent007-process-output-"));
  const outputPath = path.join(outputDir, "combined-output.log");
  const outputStream = fs.createWriteStream(outputPath, { flags: "wx" });
  let outputSizeBytes = 0;
  let outputEnded = false;
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

  const writeOutput = (chunk: Buffer | string) => {
    if (outputEnded) {
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    outputSizeBytes += buffer.byteLength;
    outputStream.write(buffer);
  };

  const collectChunk = (chunk: Buffer) => {
    writeOutput(chunk);
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
    const forceFinishDelayMs = options.timeoutBudget.killGraceMs + options.timeoutBudget.forceGraceMs;

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

    let lastSignalSent: NodeJS.Signals | null = null;

    const finish = (exitCode: number | null, stopSignal: NodeJS.Signals | null = lastSignalSent) => {
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
      const result = {
        outputPath,
        outputSizeBytes,
        exitCode: spawnError ? null : exitCode,
        stopSignal: spawnError ? null : stopSignal,
        timedOut,
        cancelled,
        stopReason,
        durationMs: Date.now() - startedAt,
      };
      outputEnded = true;
      outputStream.end(() => {
        resolve(result);
      });
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

    const appendControlMarker = (marker: string) => {
      writeOutput(marker);
      for (const line of marker.split(/\r?\n/)) {
        emitOutputLine(line);
      }
    };

    const startGracefulTermination = () => {
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

    if (options.timeoutBudget.effectiveTimeoutMs !== null) {
      timeout = setTimeout(() => {
        timedOut = true;
        const marker = timeoutMarker(options.timeoutBudget);
        appendControlMarker(marker);
        startGracefulTermination();
      }, options.timeoutBudget.effectiveTimeoutMs);
    }

    abortListener = () => {
      if (settled || closed) {
        return;
      }
      cancelled = true;
      const marker = "\n[subagent007 cancelled]\n";
      appendControlMarker(marker);
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

    child.stdout.on("data", collectChunk);
    child.stderr.on("data", collectChunk);
    child.on("error", (error) => {
      spawnError = error;
      writeOutput(`\n[spawn error] ${error.message}\n`);
    });
    child.on("close", (code, signal) => {
      closed = true;
      if (pendingLine.trim() !== "") {
        emitOutputLine(pendingLine);
      }
      finish(code, signal);
    });
  });
}
