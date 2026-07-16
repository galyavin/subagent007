import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("real Pi child fails closed before prompt when the explicit web provider is unavailable", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-child-contract-"));
  const cwd = path.join(tmp, "project");
  const agentDir = path.join(tmp, "agent");
  const requestPath = path.join(tmp, "request.json");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(requestPath, JSON.stringify({
    prompt: "must not reach prompt",
    cwd,
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "low",
    outputMode: "final",
    mailboxRoot: path.join(tmp, "mailbox"),
    runId: "contract-test",
    inputTimeoutMs: 1000,
    sessionMode: "ephemeral",
    effectProfile: "workspace_read_only",
  }));

  const output = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("dist/piChild.js"), requestPath], {
      cwd,
      env: { ...process.env, SUBAGENT007_PI_AGENT_DIR: agentDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout }));
  });

  assert.equal(output.code, 1);
  const events = output.stdout.trim().split("\n").map((line) => JSON.parse(line) as {
    type?: string;
    event?: string;
    reason_code?: string;
  });
  assert.equal(events.some((event) => event.event === "child_prompt_submitted"), false);
  assert.equal(events.some((event) => event.type === "subagent007.activation_confirmed"), false);
  assert.equal(
    events.some((event) => event.type === "subagent007.error" && event.reason_code === "effect_profile_activation_failed"),
    true,
  );
});
