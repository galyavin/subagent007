import assert from "node:assert/strict";
import { test } from "node:test";
import { toolsForProfile } from "../src/toolProfile.js";

test("tool profiles preserve local-only defaults and add opt-in web search tools", () => {
  assert.deepEqual(toolsForProfile("inspect"), ["read", "grep", "find", "ls", "request_input"]);
  assert.deepEqual(toolsForProfile("web_search"), [
    "read",
    "grep",
    "find",
    "ls",
    "request_input",
    "web_search",
    "web_read",
  ]);
  assert.deepEqual(toolsForProfile("shell"), ["read", "grep", "find", "ls", "request_input", "bash"]);
  assert.deepEqual(toolsForProfile("workspace_write"), [
    "read",
    "grep",
    "find",
    "ls",
    "request_input",
    "bash",
    "edit",
    "write",
  ]);
});
