import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  WORKSPACE_READ_ONLY_TOOL_NAMES,
  activateAllRegisteredTools,
  activateWorkspaceReadOnlyTools,
  requestInputImplementationSha256,
} from "../src/toolProfile.js";

test("activates every registered session tool", () => {
  const allTools = [
    { name: "read" },
    { name: "bash" },
    { name: "edit" },
    { name: "write" },
    { name: "grep" },
    { name: "find" },
    { name: "ls" },
    { name: "request_input" },
    { name: "web_search" },
    { name: "web_read" },
    { name: "extension_tool" },
  ];
  let activeNames: string[] = [];

  activateAllRegisteredTools({
    getAllTools: () => allTools,
    setActiveToolsByName: (toolNames) => {
      activeNames = toolNames;
    },
    getActiveToolNames: () => activeNames,
  });

  assert.deepEqual(activeNames, allTools.map((tool) => tool.name));
});

test("requires Pi web search tools", () => {
  assert.throws(
    () =>
      activateAllRegisteredTools({
        getAllTools: () => [{ name: "read" }, { name: "web_search" }],
        setActiveToolsByName: () => {},
        getActiveToolNames: () => ["read", "web_search"],
      }),
    /required Pi web search tools unavailable: web_read/,
  );
});

test("workspace_read_only activates only the exact construction-time allowlist", () => {
  const allTools = [
    ...WORKSPACE_READ_ONLY_TOOL_NAMES.map((name) => ({ name })),
    { name: "bash" },
    { name: "edit" },
    { name: "write" },
    { name: "delegate" },
    { name: "extension_tool" },
  ];
  let activeNames: string[] = [];
  activateWorkspaceReadOnlyTools({
    getAllTools: () => allTools,
    setActiveToolsByName: (names) => { activeNames = names; },
    getActiveToolNames: () => activeNames,
  });
  assert.deepEqual(activeNames, [...WORKSPACE_READ_ONLY_TOOL_NAMES]);
});

test("workspace_read_only fails closed when any allowlisted tool is unavailable", () => {
  assert.throws(
    () => activateWorkspaceReadOnlyTools({
      getAllTools: () => WORKSPACE_READ_ONLY_TOOL_NAMES
        .filter((name) => name !== "web_read")
        .map((name) => ({ name })),
      setActiveToolsByName: () => {},
      getActiveToolNames: () => WORKSPACE_READ_ONLY_TOOL_NAMES.filter((name) => name !== "web_read"),
    }),
    /workspace_read_only tools unavailable: web_read/,
  );
});

test("request_input identity covers owning runtime modules but ignores unrelated and live files", async () => {
  const releaseRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-request-input-digest-"));
  const childEntrypoint = path.join(releaseRoot, "piChild.js");
  try {
    await fs.writeFile(childEntrypoint, "import './inputMailbox.js';\n");
    await fs.writeFile(path.join(releaseRoot, "inputMailbox.js"), "export const version = 1;\n");
    await fs.writeFile(path.join(releaseRoot, "output.js"), "export const statePath = '/tmp';\n");
    await fs.writeFile(path.join(releaseRoot, "types.js"), "export class ValidationError extends Error {}\n");
    await fs.writeFile(path.join(releaseRoot, "unrelated.js"), "export const unrelated = 1;\n");
    await fs.writeFile(path.join(releaseRoot, ".subagent007-server-test.lease.json"), "{\"pid\":1}\n");
    const initial = await requestInputImplementationSha256(childEntrypoint);

    await fs.writeFile(path.join(releaseRoot, ".subagent007-server-test.lease.json"), "{\"pid\":2}\n");
    assert.equal(await requestInputImplementationSha256(childEntrypoint), initial);
    await fs.writeFile(path.join(releaseRoot, "unrelated.js"), "export const unrelated = 2;\n");
    assert.equal(await requestInputImplementationSha256(childEntrypoint), initial);

    await fs.writeFile(path.join(releaseRoot, "inputMailbox.js"), "export const version = 2;\n");
    assert.notEqual(await requestInputImplementationSha256(childEntrypoint), initial);
  } finally {
    await fs.rm(releaseRoot, { recursive: true, force: true });
  }
});
