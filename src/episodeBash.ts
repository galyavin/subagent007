import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  getShellConfig,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";

const MAX_TIMEOUT_MS = 2_147_483_647;
const POST_EXIT_IDLE_GRACE_MS = 100;
const REGISTRATION_ID_PATTERN = /^[a-f0-9]{32}$/;

export const EPISODE_PROCESS_GROUP_REGISTERED =
  "subagent007.episode_process_group_registered" as const;
export const EPISODE_PROCESS_GROUP_REGISTRATION_ACK =
  "subagent007.episode_process_group_registration_ack" as const;

export interface EpisodeProcessGroupRegistration {
  type: typeof EPISODE_PROCESS_GROUP_REGISTERED;
  version: 1;
  registration_id: string;
  process_group_id: number;
}

export interface EpisodeProcessGroupRegistrar {
  (registration: EpisodeProcessGroupRegistration): Promise<void>;
}

export function createEpisodeBashToolDefinition(options: {
  cwd: string;
  registerProcessGroup: EpisodeProcessGroupRegistrar;
  commandPrefix?: string;
  shellPath?: string;
}) {
  return createBashToolDefinition(options.cwd, {
    commandPrefix: options.commandPrefix,
    shellPath: options.shellPath,
    operations: createEpisodeBashOperations({
      registerProcessGroup: options.registerProcessGroup,
      shellPath: options.shellPath,
    }),
  });
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function parseEpisodeProcessGroupRegistration(
  line: string,
): EpisodeProcessGroupRegistration | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { type?: unknown }).type !== EPISODE_PROCESS_GROUP_REGISTERED
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ["process_group_id", "registration_id", "type", "version"]) ||
    record.version !== 1 ||
    typeof record.registration_id !== "string" ||
    !REGISTRATION_ID_PATTERN.test(record.registration_id) ||
    typeof record.process_group_id !== "number" ||
    !Number.isSafeInteger(record.process_group_id) ||
    record.process_group_id <= 0
  ) {
    throw new Error("invalid episode process-group registration frame");
  }
  return record as unknown as EpisodeProcessGroupRegistration;
}

export function episodeProcessGroupRegistrationAckFrame(registrationId: string): string {
  if (!REGISTRATION_ID_PATTERN.test(registrationId)) {
    throw new Error("invalid episode process-group registration id");
  }
  return `${JSON.stringify({
    type: EPISODE_PROCESS_GROUP_REGISTRATION_ACK,
    version: 1,
    registration_id: registrationId,
  })}\n`;
}

export function parseEpisodeProcessGroupRegistrationAck(value: unknown): string | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { type?: unknown }).type !== EPISODE_PROCESS_GROUP_REGISTRATION_ACK
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ["registration_id", "type", "version"]) ||
    record.version !== 1 ||
    typeof record.registration_id !== "string" ||
    !REGISTRATION_ID_PATTERN.test(record.registration_id)
  ) {
    throw new Error("invalid episode process-group registration acknowledgement");
  }
  return record.registration_id;
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) {
    return undefined;
  }
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
  }
  return timeoutMs;
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.removeListener("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.removeListener("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function waitForChildProcess(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = false;
    let stderrEnded = false;
    const cleanup = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout.removeListener("end", onStdoutEnd);
      child.stderr.removeListener("end", onStderrEnd);
      child.stdout.removeListener("data", onData);
      child.stderr.removeListener("data", onData);
    };
    const finish = (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(code);
    };
    const maybeFinish = () => {
      if (exited && stdoutEnded && stderrEnded) {
        finish(exitCode);
      }
    };
    const armIdleTimer = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
      }
      postExitTimer = setTimeout(() => finish(exitCode), POST_EXIT_IDLE_GRACE_MS);
    };
    const onData = () => {
      if (exited && !settled) {
        armIdleTimer();
      }
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinish();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinish();
    };
    const onError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinish();
      if (!settled) {
        armIdleTimer();
      }
    };
    const onClose = (code: number | null) => finish(code);
    child.stdout.once("end", onStdoutEnd);
    child.stderr.once("end", onStderrEnd);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

function killProcessGroup(processGroupId: number): void {
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      try {
        process.kill(processGroupId, "SIGKILL");
      } catch {
        // The process has already settled or is no longer observable to this owner.
      }
    }
  }
}

export function createEpisodeBashOperations(options: {
  registerProcessGroup: EpisodeProcessGroupRegistrar;
  shellPath?: string;
}): BashOperations {
  if (process.platform === "win32") {
    return createLocalBashOperations({ shellPath: options.shellPath });
  }
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      await fsAccess(cwd, constants.F_OK).catch(() => {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      });
      const shellConfig = getShellConfig(options.shellPath);
      const commandFromStdin = shellConfig.commandTransport === "stdin";
      const gatedCommand = commandFromStdin
        ? command
        : `IFS= read -r __subagent007_process_release || exit 125\n${command}`;
      const child = spawn(
        shellConfig.shell,
        commandFromStdin ? shellConfig.args : [...shellConfig.args, gatedCommand],
        {
          cwd,
          detached: true,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      await waitForSpawn(child);
      const processGroupId = child.pid;
      if (!processGroupId) {
        throw new Error("bash process started without an observable process-group identity");
      }
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const exit = waitForChildProcess(child);
      void exit.catch(() => undefined);
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const onAbort = () => killProcessGroup(processGroupId);
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          killProcessGroup(processGroupId);
        }, timeoutMs);
      }
      try {
        const registration: EpisodeProcessGroupRegistration = {
          type: EPISODE_PROCESS_GROUP_REGISTERED,
          version: 1,
          registration_id: randomBytes(16).toString("hex"),
          process_group_id: processGroupId,
        };
        await options.registerProcessGroup(registration);
        if (signal?.aborted) {
          killProcessGroup(processGroupId);
          throw new Error("aborted");
        }
        child.stdin.on("error", () => undefined);
        child.stdin.end(commandFromStdin ? command : "subagent007-process-release\n");
        const exitCode = await exit;
        if (signal?.aborted) {
          throw new Error("aborted");
        }
        if (timedOut) {
          throw new Error(`timeout:${timeout}`);
        }
        return { exitCode };
      } catch (error) {
        if (!child.killed) {
          killProcessGroup(processGroupId);
        }
        child.stdin.destroy();
        await exit.catch(() => undefined);
        throw error;
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
      }
    },
  };
}
