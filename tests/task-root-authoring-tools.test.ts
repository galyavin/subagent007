import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertTaskRootAuthoringPath,
  createTaskRootAuthoringTools,
  TASK_ROOT_AUTHORING_TOOL_NAMES,
} from "../src/taskRootAuthoringTools.js";

test("snapshot-bound authoring can read immutable sidecars but cannot mutate or escape them", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-snapshot-authoring-"));
  const taskRoot = path.join(parent, "isolated-task");
  const runtimeRoot = path.join(parent, "snapshot", "runtime");
  const skillFilePath = path.join(runtimeRoot, "SKILL.md");
  const guidePath = path.join(runtimeRoot, "references", "guide.md");
  const outsidePath = path.join(parent, "outside.md");
  await fs.mkdir(path.dirname(guidePath), { recursive: true });
  await fs.mkdir(taskRoot);
  await fs.writeFile(skillFilePath, "# Alpha\nSee references/guide.md.\n");
  await fs.writeFile(guidePath, "immutable guide\n");
  await fs.writeFile(outsidePath, "outside\n");

  const canonicalRuntimeRoot = await fs.realpath(runtimeRoot);
  for (const tool of ["read", "grep", "find", "ls"] as const) {
    assert.equal(
      await assertTaskRootAuthoringPath(taskRoot, "references", tool, skillFilePath),
      path.join(canonicalRuntimeRoot, "references"),
    );
  }

  const tools = createTaskRootAuthoringTools(taskRoot, skillFilePath);
  const read = tools.find((tool) => tool.name === "read")!;
  const grep = tools.find((tool) => tool.name === "grep")!;
  const find = tools.find((tool) => tool.name === "find")!;
  const ls = tools.find((tool) => tool.name === "ls")!;
  const write = tools.find((tool) => tool.name === "write")!;
  const edit = tools.find((tool) => tool.name === "edit")!;
  const context = undefined as never;

  const guide = await read.execute("read-guide", { path: "references/guide.md" }, undefined, undefined, context);
  assert.match(JSON.stringify(guide.content), /immutable guide/);
  const matches = await grep.execute("grep-guide", { path: "references", pattern: "immutable" }, undefined, undefined, context);
  assert.match(JSON.stringify(matches.content), /immutable guide/);
  const files = await find.execute("find-guide", { path: "references", pattern: "*.md" }, undefined, undefined, context);
  assert.match(JSON.stringify(files.content), /guide\.md/);
  const listing = await ls.execute("list-references", { path: "references" }, undefined, undefined, context);
  assert.match(JSON.stringify(listing.content), /guide\.md/);
  await assert.rejects(
    write.execute("write-guide", { path: guidePath, content: "mutated\n" }, undefined, undefined, context),
    /task root/,
  );
  await assert.rejects(
    edit.execute("edit-guide", { path: guidePath, edits: [{ oldText: "immutable", newText: "mutated" }] }, undefined, undefined, context),
    /task root/,
  );
  await assert.rejects(
    read.execute("read-outside", { path: outsidePath }, undefined, undefined, context),
    /task root/,
  );
  await fs.symlink(outsidePath, path.join(runtimeRoot, "references", "outside-link"));
  await assert.rejects(
    read.execute("read-snapshot-link", { path: "references/outside-link" }, undefined, undefined, context),
    /task root/,
  );

  const unboundRead = createTaskRootAuthoringTools(taskRoot).find((tool) => tool.name === "read")!;
  await assert.rejects(
    unboundRead.execute("read-sidecar-without-snapshot", { path: guidePath }, undefined, undefined, context),
    /task root/,
  );
});

test("task-root authoring path guard permits only real paths beneath the exact task root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-task-root-authoring-"));
  const outside = path.join(path.dirname(root), "outside.txt");
  await fs.writeFile(path.join(root, "inside.txt"), "inside\n");
  await fs.writeFile(outside, "outside\n");
  await fs.symlink(outside, path.join(root, "outside-link"));

  assert.deepEqual(TASK_ROOT_AUTHORING_TOOL_NAMES, ["read", "grep", "find", "ls", "write", "edit"]);
  await assertTaskRootAuthoringPath(root, "inside.txt", "read");
  await assert.rejects(
    assertTaskRootAuthoringPath(root, "../outside.txt", "read"),
    /task root/,
  );
  await assert.rejects(
    assertTaskRootAuthoringPath(root, "outside-link", "read"),
    /task root/,
  );

  const guardedRead = createTaskRootAuthoringTools(root).find((tool) => tool.name === "read")!;
  await assert.rejects(
    guardedRead.execute("tool-call", { path: "../outside.txt" }, undefined, undefined, undefined as never),
    /task root/,
  );
  await assert.rejects(
    guardedRead.execute("tool-call", { path: "outside-link" }, undefined, undefined, undefined as never),
    /task root/,
  );
});
