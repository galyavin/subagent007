import assert from "node:assert/strict";
import { test } from "node:test";
import { activateAllRegisteredTools } from "../src/toolProfile.js";

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

  const result = activateAllRegisteredTools({
    getAllTools: () => allTools,
    setActiveToolsByName: (toolNames) => {
      activeNames = toolNames;
    },
    getActiveToolNames: () => activeNames,
  });

  assert.deepEqual(result, allTools.map((tool) => tool.name));
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
