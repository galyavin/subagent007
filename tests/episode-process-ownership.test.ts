import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  createAgentSession,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createEpisodeBashOperations,
  createEpisodeBashToolDefinition,
} from "../src/episodeBash.js";
import { runChildProcess } from "../src/processRunner.js";
import { computeTimeoutBudget } from "../src/timeoutBudget.js";

type TerminalMode = "success" | "failure" | "cancellation" | "forced_child_death";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const settle = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(200, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

async function writeFixture(root: string): Promise<{
  fixturePath: string;
  serverPath: string;
  probePath: string;
}> {
  const fixturePath = path.join(root, "episode-fixture.mjs");
  const serverPath = path.join(root, "server.cjs");
  const probePath = path.join(root, "probe.cjs");
  await fs.writeFile(
    serverPath,
    [
      "const http = require('http');",
      "const port = Number(process.argv[2]);",
      "const ignoreTermination = process.argv[3] === 'ignore';",
      "if (ignoreTermination) process.on('SIGTERM', () => {});",
      "http.createServer((_request, response) => response.end('episode-ok')).listen(port, '127.0.0.1');",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    probePath,
    [
      "const port = Number(process.argv[2]);",
      "const deadline = Date.now() + 2000;",
      "async function probe() {",
      "  try {",
      "    const response = await fetch(`http://127.0.0.1:${port}/`);",
      "    if (await response.text() === 'episode-ok') { process.stdout.write('reachable'); return; }",
      "  } catch {}",
      "  if (Date.now() >= deadline) throw new Error('background server was not reachable');",
      "  setTimeout(() => void probe(), 20);",
      "}",
      "void probe().catch((error) => { console.error(error.message); process.exitCode = 1; });",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    fixturePath,
    [
      "import fs from 'node:fs/promises';",
      "const [moduleUrl, mode, serverPath, probePath, portText, pidPath, reachedPath, ignoreText] = process.argv.slice(2);",
      "const { createEpisodeBashOperations } = await import(moduleUrl);",
      "const { createPiChildControl } = await import(new URL('./piChildControl.js', moduleUrl));",
      "const control = createPiChildControl({",
      "  runId: 'episode-fixture',",
      "  writeEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\\n`),",
      "});",
      "await control.waitForOwnerCommitRelease();",
      "const operations = createEpisodeBashOperations({",
      "  registerProcessGroup: (registration) => control.registerProcessGroup(registration),",
      "});",
      "let launchOutput = '';",
      "const launch = [",
      "  JSON.stringify(process.execPath),",
      "  JSON.stringify(serverPath),",
      "  portText,",
      "  ignoreText === 'true' ? 'ignore' : 'normal',",
      "  '> /dev/null 2>&1 & echo $!',",
      "].join(' ');",
      "try {",
      "  await operations.exec(launch, process.cwd(), { onData: (chunk) => { launchOutput += chunk.toString(); } });",
      "  const serverPid = Number(launchOutput.trim().split(/\\s+/).at(-1));",
      "  if (!Number.isInteger(serverPid)) throw new Error(`missing background server pid: ${launchOutput}`);",
      "  await fs.writeFile(pidPath, String(serverPid));",
      "  let probeOutput = '';",
      "  const probe = [JSON.stringify(process.execPath), JSON.stringify(probePath), portText].join(' ');",
      "  const probeResult = await operations.exec(probe, process.cwd(), { onData: (chunk) => { probeOutput += chunk.toString(); } });",
      "  if (probeResult.exitCode !== 0 || !probeOutput.includes('reachable')) throw new Error(`later Bash call could not reach server: ${probeOutput}`);",
      "  await fs.writeFile(reachedPath, 'reachable');",
      "  process.stdout.write('fixture-server-reachable\\n');",
      "  if (mode === 'failure') throw new Error('fixture failure');",
      "  if (mode === 'forced_child_death') process.kill(process.pid, 'SIGKILL');",
      "  if (mode === 'cancellation') await new Promise(() => {});",
      "} catch (error) {",
      "  console.error(error instanceof Error ? error.message : String(error));",
      "  process.exitCode = 1;",
      "} finally {",
      "  control.dispose();",
      "}",
      "",
    ].join("\n"),
  );
  return { fixturePath, serverPath, probePath };
}

async function runTerminalCase(mode: TerminalMode, ignoreTermination: boolean): Promise<{
  result: Awaited<ReturnType<typeof runChildProcess>>;
  durationMs: number;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-episode-process-"));
  const { fixturePath, serverPath, probePath } = await writeFixture(root);
  const pidPath = path.join(root, "server.pid");
  const reachedPath = path.join(root, "reached");
  const port = await reservePort();
  const abortController = new AbortController();
  const outputLines: string[] = [];
  const startedAt = Date.now();
  const resultPromise = runChildProcess({
    command: process.execPath,
    args: [
      fixturePath,
      pathToFileURL(path.resolve("dist/episodeBash.js")).href,
      mode,
      serverPath,
      probePath,
      String(port),
      pidPath,
      reachedPath,
      String(ignoreTermination),
    ],
    cwd: root,
    timeoutBudget: computeTimeoutBudget(undefined, {
      killGraceMs: 80,
      forceGraceMs: 300,
    }),
    abortSignal: abortController.signal,
    onOutputLine: (line) => {
      outputLines.push(line);
    },
  });
  if (mode === "cancellation") {
    await waitForFile(reachedPath);
    abortController.abort();
  }
  const result = await resultPromise;
  const durationMs = Date.now() - startedAt;
  await waitForFile(pidPath);
  const serverPid = Number(await fs.readFile(pidPath, "utf8"));
  try {
    assert.equal(outputLines.includes("fixture-server-reachable"), true);
    assert.equal(
      outputLines.some((line) => line.includes("episode_process_group_registered")),
      false,
      "private process ownership frames must not enter run output",
    );
    assert.equal(processIsAlive(serverPid), false, `${mode} left server process ${serverPid} alive`);
    assert.equal(await portAcceptsConnections(port), false, `${mode} left port ${port} reachable`);
  } finally {
    if (processIsAlive(serverPid)) {
      process.kill(serverPid, "SIGKILL");
    }
  }
  return { result, durationMs };
}

test("Bash work waits for ownership registration and per-call cancellation settles its group", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-bash-registration-gate-"));
  const pidPath = path.join(root, "command.pid");
  const abortController = new AbortController();
  let observeRegistration!: () => void;
  const registrationObserved = new Promise<void>((resolve) => {
    observeRegistration = resolve;
  });
  let releaseRegistration!: () => void;
  const registrationReleased = new Promise<void>((resolve) => {
    releaseRegistration = resolve;
  });
  const operations = createEpisodeBashOperations({
    registerProcessGroup: async () => {
      observeRegistration();
      await registrationReleased;
    },
  });
  const commandSource = [
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const operation = operations.exec(
    `${shellQuote(process.execPath)} -e ${shellQuote(commandSource)}`,
    root,
    {
      onData: () => undefined,
      signal: abortController.signal,
    },
  );
  void operation.catch(() => undefined);
  await registrationObserved;
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(fs.access(pidPath), { code: "ENOENT" });
  releaseRegistration();
  await waitForFile(pidPath);
  const commandPid = Number(await fs.readFile(pidPath, "utf8"));
  abortController.abort();
  await assert.rejects(operation, /aborted/);
  assert.equal(processIsAlive(commandPid), false);
});

test("a real Pi session installs and executes the episode-owned Bash override", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-real-pi-bash-tool-"));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir);
  let registrations = 0;
  const bashTool = createEpisodeBashToolDefinition({
    cwd: root,
    registerProcessGroup: async () => {
      registrations += 1;
    },
  });
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    sessionManager: SessionManager.inMemory(root),
    tools: ["bash"],
    customTools: [bashTool as ToolDefinition<any, any, any>],
  });
  try {
    const installedBash = session.getToolDefinition("bash");
    assert.equal(installedBash, bashTool, "the custom Bash definition must replace Pi's built-in");
    assert.deepEqual(session.getActiveToolNames(), ["bash"]);
    assert.ok(installedBash);
    await installedBash.execute(
      "episode-bash-tool-test",
      { command: "printf installed-episode-bash" },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(registrations, 1, "the installed Bash call must cross the ownership gate");
  } finally {
    session.dispose();
  }
});

for (const mode of ["success", "failure", "cancellation", "forced_child_death"] as const) {
  test(`episode-owned Bash server is reachable during the episode and absent after ${mode}`, async () => {
    if (process.platform === "win32") {
      return;
    }
    const { result } = await runTerminalCase(mode, false);
    if (mode === "success") {
      assert.equal(result.stopReason, "completed");
      assert.equal(result.exitCode, 0);
    } else if (mode === "cancellation") {
      assert.equal(result.stopReason, "cancelled");
      assert.equal(result.cancelled, true);
    } else {
      assert.equal(result.stopReason, "failed");
    }
  });
}

test("episode process settlement escalates past ignored graceful termination", async () => {
  if (process.platform === "win32") {
    return;
  }
  const { result, durationMs } = await runTerminalCase("success", true);
  assert.equal(result.stopReason, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(durationMs >= 80, true, "ignored SIGTERM should consume the graceful settlement window");
  assert.equal(durationMs < 2_500, true, "forced settlement must remain bounded");
});
