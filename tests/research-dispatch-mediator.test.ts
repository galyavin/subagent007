import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createResearchDispatchExtension,
  ResearchDispatchMediator,
} from "../src/researchDispatchMediator.js";
import {
  BoundedControllerExecutionQueue,
  type ResearchDispatchController,
  type ResearchDispatchControllerCommand,
} from "../src/boundedController.js";

function controllerFixture() {
  const calls: Array<{ subcommand: string; argv: string[] }> = [];
  const controller: ResearchDispatchController = {
    async execute(subcommand: ResearchDispatchControllerCommand, argv: readonly string[]) {
      const command = { subcommand, argv: [...argv] };
      calls.push(command);
      const stdout = command.subcommand === "claim-dispatch" ? "A1\n" : "";
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, subcommand: command.subcommand, stdout, stderr: "" }),
        }],
        details: undefined,
      };
    },
  };
  return { calls, controller };
}

test("research dispatch mediator claims matching web calls and records exactly one result", async () => {
  const fixture = controllerFixture();
  const mediator = new ResearchDispatchMediator({
    controller: fixture.controller,
    jobPath: "/task/state/job.json",
  });
  assert.equal(await mediator.claim({
    toolCallId: "call-1",
    toolName: "web_search",
    input: { query: "terms", limit: 5 },
  }), undefined);
  assert.equal(fixture.calls[0]?.subcommand, "claim-dispatch");
  assert.equal(fixture.calls[0]?.argv.at(-1), '{"limit":5,"query":"terms"}');

  await mediator.record({
    toolCallId: "call-1",
    toolName: "web_search",
    content: [{ type: "text", text: "result" }],
    isError: false,
  });
  assert.equal(fixture.calls[1]?.subcommand, "record-dispatch-result");
  assert.ok(fixture.calls[1]?.argv.includes("returned"));
  await assert.rejects(
    () => mediator.record({
      toolCallId: "call-1",
      toolName: "web_search",
      content: [{ type: "text", text: "duplicate" }],
      isError: false,
    }),
    /not claimed/,
  );
});

test("research dispatch mediator blocks missing reservations before provider execution", async () => {
  const fixture = controllerFixture();
  fixture.controller.execute = async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        success: false,
        subcommand: "claim-dispatch",
        stdout: "",
        stderr: "researchctl: web dispatch requires a sole pending match",
      }),
    }],
    details: undefined,
  });
  const mediator = new ResearchDispatchMediator({
    controller: fixture.controller,
    jobPath: "/task/state/job.json",
  });
  assert.deepEqual(await mediator.claim({
    toolCallId: "call-1",
    toolName: "web_read",
    input: { url: "https://example.test" },
  }), {
    block: true,
    reason: "researchctl: web dispatch requires a sole pending match",
  });
});

test("research dispatch extension handles only top-level Researcher web tools", () => {
  const fixture = controllerFixture();
  const registrations = new Map<string, (...args: any[]) => unknown>();
  createResearchDispatchExtension({
    controller: fixture.controller,
    jobPath: "/task/state/job.json",
  })({
    on: (name: string, handler: (...args: any[]) => unknown) => {
      registrations.set(name, handler);
    },
  } as never);
  assert.ok(registrations.has("tool_call"));
  assert.ok(registrations.has("tool_result"));
});

test("controller queue serializes writes, releases rejection, and preserves later state", async () => {
  const queue = new BoundedControllerExecutionQueue();
  const order: string[] = [];
  const rejected = queue.run(async () => {
    order.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("first:reject");
    throw new Error("injected controller rejection");
  });
  const accepted = queue.run(async () => {
    order.push("second:start");
    order.push("second:commit");
    return "committed";
  });
  await assert.rejects(rejected, /injected controller rejection/);
  assert.equal(await accepted, "committed");
  assert.deepEqual(order, [
    "first:start",
    "first:reject",
    "second:start",
    "second:commit",
  ]);
});

test("mediator keeps a claimed reservation observable until result recording succeeds", async () => {
  const fixture = controllerFixture();
  let rejectRecord = true;
  const originalExecute = fixture.controller.execute.bind(fixture.controller);
  fixture.controller.execute = async (subcommand, argv) => {
    if (subcommand === "record-dispatch-result" && rejectRecord) {
      rejectRecord = false;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            subcommand,
            stdout: "",
            stderr: "injected record rejection",
          }),
        }],
        details: undefined,
      };
    }
    return originalExecute(subcommand, argv);
  };
  const mediator = new ResearchDispatchMediator({
    controller: fixture.controller,
    jobPath: "/task/state/job.json",
  });
  assert.equal(await mediator.claim({
    toolCallId: "retryable-result",
    toolName: "web_search",
    input: { query: "terms" },
  }), undefined);
  const result = {
    toolCallId: "retryable-result",
    toolName: "web_search",
    content: [{ type: "text" as const, text: "result" }],
    isError: false,
  };
  await assert.rejects(() => mediator.record(result), /injected record rejection/);
  await assert.doesNotReject(() => mediator.record(result));
});

test("an unobserved claimed call does not retain the controller queue lease", async () => {
  const fixture = controllerFixture();
  const queue = new BoundedControllerExecutionQueue();
  const queuedController: ResearchDispatchController = {
    execute: (subcommand, argv) =>
      queue.run(() => fixture.controller.execute(subcommand, argv)),
  };
  const mediator = new ResearchDispatchMediator({
    controller: queuedController,
    jobPath: "/task/state/job.json",
  });
  assert.equal(await mediator.claim({
    toolCallId: "unobserved",
    toolName: "web_read",
    input: { url: "https://example.test/one" },
  }), undefined);
  assert.equal(await mediator.claim({
    toolCallId: "later",
    toolName: "web_read",
    input: { url: "https://example.test/two" },
  }), undefined);
  assert.deepEqual(
    fixture.calls.map((call) => call.subcommand),
    ["claim-dispatch", "claim-dispatch"],
  );
});
