import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const lockModuleUrl = pathToFileURL(path.resolve("src/runClaimLock.ts")).href;

function worker(source: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  return {
    child,
    result: new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    }),
  };
}

async function waitFor(predicate: () => Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function transitionWorkerSource(input: {
  runTasksDir: string;
  claimPath: string;
  runId: string;
  readyPath: string;
  continuePath: string;
  value: string;
}): string {
  return `
    import fs from "node:fs/promises";
    import { withRunClaimLock } from ${JSON.stringify(lockModuleUrl)};
    const input = ${JSON.stringify(input)};
    const observed = JSON.parse(await fs.readFile(input.claimPath, "utf8"));
    await fs.writeFile(input.readyPath, JSON.stringify(observed));
    while (!await fs.stat(input.continuePath).then(() => true, () => false)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const outcome = await withRunClaimLock(input.runTasksDir, input.runId, async () => {
      const current = JSON.parse(await fs.readFile(input.claimPath, "utf8"));
      if (current.values.includes(input.value)) return "exact_noop";
      current.values.push(input.value);
      const temporary = input.claimPath + ".tmp-" + process.pid;
      await fs.writeFile(temporary, JSON.stringify(current));
      await fs.rename(temporary, input.claimPath);
      return "committed";
    });
    process.stdout.write(outcome);
  `;
}

test("two independent processes reread under the per-run claim critical section", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-run-claim-two-process-"));
  const runTasksDir = path.join(root, "run-tasks");
  const claimPath = path.join(runTasksDir, "claim.json");
  const continuePath = path.join(root, "continue");
  await fs.mkdir(runTasksDir);
  await fs.writeFile(claimPath, JSON.stringify({ values: [] }));
  try {
    const inputs = ["grant", "grant"].map((value, index) => ({
      runTasksDir,
      claimPath,
      runId: "two-process-run",
      readyPath: path.join(root, `ready-${index}`),
      continuePath,
      value,
    }));
    const workers = inputs.map((input) => worker(transitionWorkerSource(input)));
    await waitFor(async () => (await Promise.all(inputs.map((input) => fs.stat(input.readyPath).then(() => true, () => false)))).every(Boolean), "workers did not read revision N");
    assert.deepEqual(await Promise.all(inputs.map(async (input) => JSON.parse(await fs.readFile(input.readyPath, "utf8")))), [
      { values: [] },
      { values: [] },
    ]);
    await fs.writeFile(continuePath, "continue\n");
    const results = await Promise.all(workers.map((entry) => entry.result));
    assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.stderr).join("\n"));
    assert.deepEqual(results.map((result) => result.stdout).sort(), ["committed", "exact_noop"]);
    assert.deepEqual(JSON.parse(await fs.readFile(claimPath, "utf8")), { values: ["grant"] });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a process crash inside a claim transition leaves only a recoverable mechanical lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-run-claim-crash-"));
  const runTasksDir = path.join(root, "run-tasks");
  const claimPath = path.join(runTasksDir, "claim.json");
  const barrier = path.join(root, "barrier");
  await fs.mkdir(runTasksDir);
  await fs.writeFile(claimPath, JSON.stringify({ values: [] }));
  const crashed = worker(`
    import fs from "node:fs/promises";
    import { withRunClaimLock } from ${JSON.stringify(lockModuleUrl)};
    await withRunClaimLock(${JSON.stringify(runTasksDir)}, "crash-run", async () => {
      await fs.writeFile(${JSON.stringify(barrier)}, "ready\\n", { flag: "wx" });
      while (true) await new Promise((resolve) => setTimeout(resolve, 1000));
    });
  `);
  try {
    await waitFor(() => fs.stat(barrier).then(() => true, () => false), "crash worker did not acquire claim lock");
    crashed.child.kill("SIGKILL");
    const crashedResult = await crashed.result;
    assert.equal(crashedResult.signal, "SIGKILL");

    const continuePath = path.join(root, "continue");
    const readyPath = path.join(root, "ready-successor");
    const successor = worker(transitionWorkerSource({
      runTasksDir,
      claimPath,
      runId: "crash-run",
      readyPath,
      continuePath,
      value: "terminal",
    }));
    await waitFor(() => fs.stat(readyPath).then(() => true, () => false), "successor did not read current claim");
    await fs.writeFile(continuePath, "continue\n");
    const result = await successor.result;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "committed");
    assert.deepEqual(JSON.parse(await fs.readFile(claimPath, "utf8")), { values: ["terminal"] });
    assert.deepEqual(await fs.readdir(path.join(runTasksDir, ".claim-locks")), []);
  } finally {
    if (crashed.child.exitCode === null && crashed.child.signalCode === null) crashed.child.kill("SIGKILL");
    await fs.rm(root, { recursive: true, force: true });
  }
});
