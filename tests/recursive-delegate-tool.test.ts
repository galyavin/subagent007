import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRecursiveDelegateTool } from "../src/recursiveDelegateTool.js";
import type { RecursiveControlChildConfig } from "../src/recursiveControl.js";

async function observeDelegateParams(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-recursive-tool-"));
  const socketPath = path.join(root, "control.sock");
  const token = "recursive-tool-test-token";
  let resolveObserved: (value: Record<string, unknown>) => void;
  const observed = new Promise<Record<string, unknown>>((resolve) => {
    resolveObserved = resolve;
  });
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        id: string;
        params: Record<string, unknown>;
      };
      resolveObserved(request.params);
      socket.end(`${JSON.stringify({
        id: request.id,
        ok: true,
        result: { status: "completed", success: true },
      })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const recursiveControl: RecursiveControlChildConfig = {
    socket_path: socketPath,
    token,
    parent_run_id: "parent-run",
    root_run_id: "root-run",
    recursion_depth: 0,
  };
  try {
    const tool = createRecursiveDelegateTool({ cwd: root, recursiveControl });
    assert.ok(tool);
    await tool.execute(
      "tool-call",
      { prompt: "bounded work", ...params } as never,
      new AbortController().signal,
      () => {},
      undefined as never,
    );
    return await observed;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("recursive delegate omission requests the bounded private maximum", async () => {
  const observed = await observeDelegateParams({});
  assert.equal(observed.wait_ms, 30_000);
  assert.equal(Object.hasOwn(observed, "timeout_ms"), false);
});

test("recursive delegate preserves explicit zero and positive waits", async () => {
  assert.equal((await observeDelegateParams({ wait_ms: 0 })).wait_ms, 0);
  assert.equal((await observeDelegateParams({ wait_ms: 1733 })).wait_ms, 1733);
});

test("recursive delegate maps an explicit hard lifetime to the durable timeout mechanic", async () => {
  const observed = await observeDelegateParams({ hard_timeout_ms: 1733 });
  assert.equal(observed.timeout_ms, 1733);
  assert.equal(Object.hasOwn(observed, "hard_timeout_ms"), false);
});

test("recursive delegate guidance distinguishes observation from termination authority", () => {
  const tool = createRecursiveDelegateTool({
    cwd: "/tmp",
    recursiveControl: {
      socket_path: "/tmp/subagent007-recursive-guidance.sock",
      token: "guidance-token",
      parent_run_id: "parent-run",
      root_run_id: "root-run",
      recursion_depth: 0,
    },
  });
  assert.ok(tool);
  assert.match(tool.description, /omission waits up to 30,000 ms/i);
  assert.match(tool.description, /wait_ms:0 returns immediately/i);
  assert.match(tool.description, /omit hard_timeout_ms for no time-based termination/i);
  const guidelines = tool.promptGuidelines ?? [];
  assert.match(guidelines.join("\n"), /still owns the descendant/i);
  assert.match(guidelines.join("\n"), /use rejoin with the returned run_id/i);
  assert.match(guidelines.join("\n"), /hard_timeout_ms.*terminate the descendant/i);
  const properties = (tool.parameters as unknown as { properties: Record<string, unknown> }).properties;
  assert.equal(Object.hasOwn(properties, "hard_timeout_ms"), true);
  assert.equal(Object.hasOwn(properties, "timeout_ms"), false);
});
