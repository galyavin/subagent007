import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { terminateOwnedProcessGroupOnControlLoss } from "./controlChannel.js";
import {
  parseEpisodeProcessGroupRegistrationAck,
  type EpisodeProcessGroupRegistration,
} from "./episodeBash.js";
import { CHILD_OWNER_COMMIT_RELEASE_FRAME } from "./processRunner.js";

const PROCESS_GROUP_REGISTRATION_TIMEOUT_MS = 5_000;

export interface PiChildInputResponse {
  requestId: string;
  responseId: string;
  answer: string;
  receivedAt: string;
}

export interface PiChildControl {
  waitForOwnerCommitRelease(): Promise<void>;
  registerProcessGroup(registration: EpisodeProcessGroupRegistration): Promise<void>;
  waitForResponse(requestId: string, timeoutMs: number): Promise<PiChildInputResponse>;
  dispose(): void;
}

export function createPiChildControl(options: {
  runId: string;
  writeEvent: (event: unknown) => void;
  input?: Readable;
  onUnexpectedClose?: () => void;
}): PiChildControl {
  const buffered = new Map<string, PiChildInputResponse>();
  const waiters = new Map<string, (response: PiChildInputResponse) => void>();
  const processGroupWaiters = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  const reader = createInterface({ input: options.input ?? process.stdin, crlfDelay: Infinity });
  let releaseOwnerCommit!: () => void;
  const ownerCommitRelease = new Promise<void>((resolve) => {
    releaseOwnerCommit = resolve;
  });
  let ownerCommitReleased = false;
  let disposed = false;

  reader.on("close", () => {
    if (!disposed) {
      (options.onUnexpectedClose ?? terminateOwnedProcessGroupOnControlLoss)();
    }
  });
  reader.on("line", (line) => {
    try {
      const message = JSON.parse(line) as {
        type?: unknown;
        request_id?: unknown;
        response_id?: unknown;
        answer?: unknown;
      };
      if (!ownerCommitReleased && `${line}\n` === CHILD_OWNER_COMMIT_RELEASE_FRAME) {
        ownerCommitReleased = true;
        releaseOwnerCommit();
        return;
      }
      const processGroupRegistrationId = parseEpisodeProcessGroupRegistrationAck(message);
      if (processGroupRegistrationId) {
        const waiter = processGroupWaiters.get(processGroupRegistrationId);
        if (waiter) {
          processGroupWaiters.delete(processGroupRegistrationId);
          clearTimeout(waiter.timeout);
          waiter.resolve();
        }
        return;
      }
      if (
        message.type !== "subagent007.input_response" ||
        typeof message.request_id !== "string" ||
        typeof message.response_id !== "string" ||
        typeof message.answer !== "string"
      ) {
        return;
      }
      const response: PiChildInputResponse = {
        requestId: message.request_id,
        responseId: message.response_id,
        answer: message.answer,
        receivedAt: new Date().toISOString(),
      };
      const waiter = waiters.get(response.requestId);
      if (waiter) {
        waiters.delete(response.requestId);
        waiter(response);
        return;
      }
      buffered.set(response.requestId, response);
    } catch {
      // The parent owns this private channel. Malformed frames cannot become tool input.
    }
  });

  return {
    waitForOwnerCommitRelease() {
      return ownerCommitRelease;
    },
    registerProcessGroup(registration) {
      if (disposed) {
        return Promise.reject(
          new Error("child control channel closed before process ownership registration"),
        );
      }
      if (processGroupWaiters.has(registration.registration_id)) {
        return Promise.reject(new Error("duplicate episode process-group registration id"));
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          processGroupWaiters.delete(registration.registration_id);
          reject(new Error("episode process-group ownership registration timed out"));
        }, PROCESS_GROUP_REGISTRATION_TIMEOUT_MS);
        processGroupWaiters.set(registration.registration_id, { resolve, reject, timeout });
        options.writeEvent(registration);
      });
    },
    waitForResponse(requestId, timeoutMs) {
      const accept = (response: PiChildInputResponse): PiChildInputResponse => {
        options.writeEvent({
          type: "subagent007.input_response_accepted",
          run_id: options.runId,
          request_id: response.requestId,
          response_id: response.responseId,
        });
        return response;
      };
      const alreadyReceived = buffered.get(requestId);
      if (alreadyReceived) {
        buffered.delete(requestId);
        return Promise.resolve(accept(alreadyReceived));
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(requestId);
          reject(new Error(`input request timed out: ${requestId}`));
        }, timeoutMs);
        waiters.set(requestId, (response) => {
          clearTimeout(timeout);
          resolve(accept(response));
        });
      });
    },
    dispose() {
      disposed = true;
      reader.close();
      for (const waiter of processGroupWaiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(
          new Error("child control channel closed before process ownership registration"),
        );
      }
      processGroupWaiters.clear();
      waiters.clear();
      buffered.clear();
    },
  };
}
