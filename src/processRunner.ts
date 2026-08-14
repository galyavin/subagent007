import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fsp from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import {
  episodeProcessGroupRegistrationAckFrame,
  parseEpisodeProcessGroupRegistration,
} from "./episodeBash.js";
import { DEFAULT_HEARTBEAT_INTERVAL_MS, type HeartbeatNotify } from "./progress.js";
import type { TimeoutBudget } from "./timeoutBudget.js";
import type { RunStopReason } from "./types.js";

export const CHILD_OWNER_COMMIT_RELEASE_FRAME =
  `${JSON.stringify({ type: "subagent007.owner_commit_release", version: 1 })}\n`;
const PROCESS_GROUP_RECHECK_INTERVAL_MS = 100;

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
  onChildSpawned?: (occurredAt: string) => void | Promise<void>;
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
  if (options.abortSignal?.aborted) {
    return {
      exitCode: null,
      stopSignal: null,
      timedOut: false,
      cancelled: true,
      resourceExhausted: false,
      stopReason: "cancelled",
      durationMs: 0,
    };
  }

  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const writeControlFrame = (frame: string): Promise<void> => new Promise((release, rejectWrite) => {
      if (child.stdin.destroyed || !child.stdin.writable) {
        rejectWrite(new Error("child control pipe closed before process ownership was established"));
        return;
      }
      child.stdin.write(frame, (error) => {
        if (error) {
          rejectWrite(error);
        } else {
          release();
        }
      });
    });
    let resolveSpawnObservation!: () => void;
    let rejectSpawnObservation!: (error: Error) => void;
    let spawnObservationError: Error | undefined;
    const spawnObservation = new Promise<void>((resolve, reject) => {
      resolveSpawnObservation = resolve;
      rejectSpawnObservation = reject;
    });
    void spawnObservation.catch(() => undefined);
    const releaseChildAfterOwnerCommit = (): Promise<void> =>
      writeControlFrame(CHILD_OWNER_COMMIT_RELEASE_FRAME);
    child.once("spawn", () => {
      const occurredAt = new Date().toISOString();
      void Promise.resolve()
        .then(() => options.onChildSpawned?.(occurredAt))
        .then(releaseChildAfterOwnerCommit)
        .then(
        () => resolveSpawnObservation(),
        (error: unknown) => {
          spawnObservationError = error instanceof Error ? error : new Error(String(error));
          outputError ??= spawnObservationError;
          startGracefulTermination();
          rejectSpawnObservation(spawnObservationError);
        },
      );
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
    let processGroupObservationInterval: NodeJS.Timeout | undefined;
    let heartbeatBeat = 0;
    let heartbeatInFlight = false;
    let diskCheckInFlight = false;
    let abortListener: (() => void) | undefined;
    let cleanupOnParentExit: (() => void) | undefined;
    let terminationStarted = false;
    let terminationStartedAt: number | undefined;
    let lastSignalSent: NodeJS.Signals | null = null;
    let outputChain: Promise<void> = spawnObservation;
    const ownedProcessGroups = new Set<number>();
    const processGroupRegistrations = new Map<string, number>();
    let episodeSettlement: Promise<boolean> | undefined;
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
      if (processGroupObservationInterval) {
        clearInterval(processGroupObservationInterval);
      }
    };

    const signalProcessGroup = (processGroupId: number, signal: NodeJS.Signals) => {
      try {
        process.kill(-processGroupId, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          try {
            process.kill(processGroupId, signal);
          } catch {
            // The owned group has already settled or is no longer observable.
          }
        }
      }
    };

    const signalOwnedProcessGroups = (signal: NodeJS.Signals, includeChildGroup: boolean) => {
      if (process.platform === "win32") {
        return;
      }
      if (includeChildGroup && child.pid) {
        signalProcessGroup(child.pid, signal);
      }
      for (const processGroupId of ownedProcessGroups) {
        signalProcessGroup(processGroupId, signal);
      }
    };

    const signalChild = (signal: NodeJS.Signals) => {
      lastSignalSent = signal;
      if (!child.pid) {
        return;
      }
      if (process.platform !== "win32") {
        signalProcessGroup(child.pid, signal);
        return;
      }
      child.kill(signal);
    };

    const processGroupExists = (processGroupId: number): boolean => {
      try {
        process.kill(-processGroupId, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };

    const retireAbsentOwnedProcessGroups = () => {
      for (const processGroupId of ownedProcessGroups) {
        if (!processGroupExists(processGroupId)) {
          ownedProcessGroups.delete(processGroupId);
        }
      }
      if (ownedProcessGroups.size === 0 && processGroupObservationInterval) {
        clearInterval(processGroupObservationInterval);
        processGroupObservationInterval = undefined;
      }
    };

    const observeOwnedProcessGroups = () => {
      retireAbsentOwnedProcessGroups();
      if (ownedProcessGroups.size > 0 && !processGroupObservationInterval) {
        processGroupObservationInterval = setInterval(
          retireAbsentOwnedProcessGroups,
          PROCESS_GROUP_RECHECK_INTERVAL_MS,
        );
      }
    };

    const allEpisodeProcessGroupsAbsent = (): boolean => {
      if (process.platform === "win32") {
        return true;
      }
      retireAbsentOwnedProcessGroups();
      const processGroupIds = new Set(ownedProcessGroups);
      if (child.pid) {
        processGroupIds.add(child.pid);
      }
      return [...processGroupIds].every((processGroupId) => !processGroupExists(processGroupId));
    };

    const waitForEpisodeProcessGroupsAbsent = async (deadline: number): Promise<boolean> => {
      while (!allEpisodeProcessGroupsAbsent()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return false;
        }
        await new Promise((release) => setTimeout(release, Math.min(10, remaining)));
      }
      return true;
    };

    const settleEpisodeProcessGroups = async (): Promise<boolean> => {
      if (process.platform === "win32" || allEpisodeProcessGroupsAbsent()) {
        return true;
      }
      const gracefulStartedAt = terminationStartedAt ?? Date.now();
      if (terminationStartedAt === undefined) {
        signalOwnedProcessGroups("SIGTERM", true);
      }
      const killAt = gracefulStartedAt + options.timeoutBudget.killGraceMs;
      if (await waitForEpisodeProcessGroupsAbsent(killAt)) {
        return true;
      }
      signalOwnedProcessGroups("SIGKILL", true);
      return waitForEpisodeProcessGroupsAbsent(killAt + options.timeoutBudget.forceGraceMs);
    };

    const startEpisodeProcessSettlement = (): Promise<boolean> => {
      episodeSettlement ??= settleEpisodeProcessGroups();
      return episodeSettlement;
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
      void outputChain.then(
        () => {
          if (spawnObservationError) {
            reject(spawnObservationError);
          } else {
            resolve(result);
          }
        },
        (error: unknown) => reject(
          spawnObservationError ?? (error instanceof Error ? error : new Error(String(error))),
        ),
      );
    };

    const startGracefulTermination = () => {
      if (terminationStarted) {
        return;
      }
      terminationStarted = true;
      terminationStartedAt = Date.now();
      signalChild("SIGTERM");
      signalOwnedProcessGroups("SIGTERM", false);
      killTimeout = setTimeout(() => {
        if (!closed) {
          signalChild("SIGKILL");
        } else {
          signalOwnedProcessGroups("SIGKILL", true);
        }
        signalOwnedProcessGroups("SIGKILL", false);
      }, options.timeoutBudget.killGraceMs);
      forceTimeout = setTimeout(() => {
        if (!closed) {
          if (!allEpisodeProcessGroupsAbsent()) {
            outputError ??= new Error("episode-owned processes did not settle after forced termination");
          }
          finish(null);
        }
      }, forceFinishDelayMs);
    };

    const queueOutputLine = (line: string): Promise<void> => {
      const operation = outputChain.then(async () => {
        if (spawnObservationError) throw spawnObservationError;
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

    const consumeStream = async (
      stream: ChildProcessWithoutNullStreams["stdout"],
      acceptsProcessOwnershipFrames: boolean,
    ): Promise<void> => {
      const decoder = new StringDecoder("utf8");
      let pendingLine = "";
      const consumeLine = async (line: string) => {
        const registration = acceptsProcessOwnershipFrames
          ? parseEpisodeProcessGroupRegistration(line)
          : null;
        if (!registration) {
          await queueOutputLine(line);
          return;
        }
        if (process.platform === "win32" || !child.pid || registration.process_group_id === child.pid) {
          throw new Error("child reported an invalid episode process-group owner");
        }
        const previousProcessGroupId = processGroupRegistrations.get(registration.registration_id);
        if (
          previousProcessGroupId !== undefined &&
          previousProcessGroupId !== registration.process_group_id
        ) {
          throw new Error("child reused an episode process-group registration id");
        }
        processGroupRegistrations.set(registration.registration_id, registration.process_group_id);
        if (!processGroupExists(registration.process_group_id)) {
          throw new Error("child reported an absent episode process group");
        }
        ownedProcessGroups.add(registration.process_group_id);
        observeOwnedProcessGroups();
        if (terminationStarted) {
          signalProcessGroup(registration.process_group_id, "SIGTERM");
          return;
        }
        await writeControlFrame(
          episodeProcessGroupRegistrationAckFrame(registration.registration_id),
        );
      };
      for await (const chunk of stream) {
        pendingLine += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const lines = pendingLine.split(/\r?\n/);
        pendingLine = lines.pop() ?? "";
        for (const line of lines) {
          await consumeLine(line);
        }
      }
      pendingLine += decoder.end();
      if (pendingLine.trim() !== "") {
        await consumeLine(pendingLine);
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
      signalOwnedProcessGroups("SIGKILL", true);
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
      consumeStream(child.stdout, true),
      consumeStream(child.stderr, false),
    ]).catch((error: unknown) => {
      outputError ??= error instanceof Error ? error : new Error(String(error));
      if (isDiskExhaustionError(error)) {
        resourceExhausted = true;
      }
      startGracefulTermination();
    });

    child.on("error", (error) => {
      spawnError = error;
      resolveSpawnObservation();
      appendControlMarker(`[spawn error] ${error.message}`);
    });
    child.on("exit", () => {
      void startEpisodeProcessSettlement();
    });
    child.on("close", (code, signal) => {
      closed = true;
      void consumers.then(async () => {
        const processGroupsSettled = await startEpisodeProcessSettlement();
        if (!processGroupsSettled) {
          outputError ??= new Error("episode-owned processes remained after forced settlement");
          finish(null, null);
          return;
        }
        finish(code, signal);
      });
    });
  });
}
