import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BUILD_SCRIPT = path.resolve("scripts/build-atomic.mjs");
const CANDIDATE_MARKER = ".subagent007-build-candidate.json";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Fixture {
  root: string;
  dist: string;
  counter: string;
  run(args: string[]): Promise<CommandResult>;
  stage(name: string): Promise<string>;
}

function wrapperBody(entry: string): string {
  return entry === "server.js" || entry === "piChild.js"
    ? `#!/usr/bin/env node\nimport "./current/${entry}";\n`
    : `export * from "./current/${entry}";\n`;
}

async function runCommand(root: string, args: string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync(process.execPath, [path.join(root, "scripts", "build-atomic.mjs"), ...args], {
      cwd: root,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

async function createFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-build-atomic-"));
  const dist = path.join(root, "dist");
  const seedRelease = path.join(dist, "releases", "seed");
  const counter = path.join(root, "fake-tsc-count.txt");
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "typescript", "bin"), { recursive: true });
  await fs.mkdir(seedRelease, { recursive: true });
  await fs.copyFile(BUILD_SCRIPT, path.join(root, "scripts", "build-atomic.mjs"));
  await fs.writeFile(path.join(root, "tsconfig.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(seedRelease, "server.js"), "export const build = 'seed';\n", "utf8");
  await fs.writeFile(path.join(seedRelease, "piChild.js"), "export const child = 'seed';\n", "utf8");
  await fs.writeFile(path.join(seedRelease, "library.js"), "export const library = 'seed';\n", "utf8");
  await fs.symlink(path.join("releases", "seed"), path.join(dist, "current"), "dir");
  for (const entry of ["server.js", "piChild.js", "library.js"]) {
    await fs.writeFile(path.join(dist, entry), wrapperBody(entry), { mode: entry === "server.js" || entry === "piChild.js" ? 0o755 : 0o644 });
  }
  await fs.writeFile(
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    [
      "import fs from 'node:fs/promises';",
      "import path from 'node:path';",
      "const outDir = process.argv[process.argv.indexOf('--outDir') + 1];",
      "const counter = path.join(process.cwd(), 'fake-tsc-count.txt');",
      "const previous = Number(await fs.readFile(counter, 'utf8').catch(() => '0'));",
      "const build = previous + 1;",
      "await fs.writeFile(counter, String(build));",
      "if (process.env.FAKE_TSC_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_TSC_DELAY_MS)));",
      "await fs.mkdir(path.join(outDir, 'nested'), { recursive: true });",
      "await fs.writeFile(path.join(outDir, 'server.js'), `export const build = '${build}';\\n`);",
      "await fs.writeFile(path.join(outDir, 'piChild.js'), `export const child = '${build}';\\n`);",
      "await fs.writeFile(path.join(outDir, 'library.js'), `export const library = '${build}';\\n`);",
      "await fs.writeFile(path.join(outDir, 'z.js'), `export const z = '${build}';\\n`);",
      "await fs.writeFile(path.join(outDir, 'ä.js'), `export const a = '${build}';\\n`);",
      "await fs.writeFile(path.join(outDir, 'nested', 'chunk.js'), `export const chunk = '${build}';\\n`);",
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    root,
    dist,
    counter,
    run: (args) => runCommand(root, args),
    async stage(name) {
      const locator = path.join(root, `${name}.json`);
      const result = await runCommand(root, ["--stage-only", "--manifest-out", locator]);
      assert.equal(result.code, 0, result.stderr);
      return locator;
    },
  };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
}

async function publicationBytes(dist: string): Promise<{ current: string; wrappers: Record<string, string> }> {
  const wrappers: Record<string, string> = {};
  for (const entry of await fs.readdir(dist)) {
    if (entry.endsWith(".js")) {
      wrappers[entry] = (await fs.readFile(path.join(dist, entry))).toString("base64");
    }
  }
  return { current: await fs.readlink(path.join(dist, "current")), wrappers };
}

async function locatorRelease(locator: string): Promise<string> {
  const parsed = JSON.parse(await fs.readFile(locator, "utf8")) as { release_id: string };
  return parsed.release_id;
}

async function candidateMarker(fixture: Fixture, locator: string): Promise<{ retention: string }> {
  return JSON.parse(
    await fs.readFile(path.join(fixture.dist, "releases", await locatorRelease(locator), CANDIDATE_MARKER), "utf8"),
  ) as { retention: string };
}

async function fileDigest(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function fixtureTreeIdentity(root: string): Promise<Array<Record<string, string | number>>> {
  const identity: Array<Record<string, string | number>> = [];
  async function visit(directory: string): Promise<void> {
    const children = (await fs.readdir(directory)).sort();
    for (const child of children) {
      const absolutePath = path.join(directory, child);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      const stats = await fs.lstat(absolutePath);
      if (stats.isDirectory()) {
        identity.push({ path: relativePath, type: "directory", mode: stats.mode & 0o777 });
        await visit(absolutePath);
      } else if (stats.isFile()) {
        identity.push({
          path: relativePath,
          type: "file",
          mode: stats.mode & 0o777,
          bytes: stats.size,
          sha256: await fileDigest(absolutePath),
        });
      } else if (stats.isSymbolicLink()) {
        identity.push({ path: relativePath, type: "symlink", target: await fs.readlink(absolutePath) });
      } else {
        identity.push({ path: relativePath, type: "other", mode: stats.mode & 0o777 });
      }
    }
  }
  await visit(root);
  return identity;
}

async function startLockedCommand(fixture: Fixture, args: string[]): Promise<ReturnType<typeof spawn>> {
  const lock = path.join(fixture.dist, ".build-lock");
  await fs.mkdir(lock, { recursive: true });
  await fs.writeFile(path.join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`, "utf8");
  return spawn(process.execPath, [path.join(fixture.root, "scripts", "build-atomic.mjs"), ...args], {
    cwd: fixture.root,
    stdio: "ignore",
  });
}

async function releaseLock(fixture: Fixture): Promise<void> {
  await fs.rm(path.join(fixture.dist, ".build-lock"), { recursive: true, force: true });
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

test("stage-only leaves current and stable wrappers byte-identical", async () => {
  await withFixture(async (fixture) => {
    const before = await publicationBytes(fixture.dist);
    const locator = path.join(fixture.root, "candidate.json");
    const result = await fixture.run(["--stage-only", "--manifest-out", locator]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await publicationBytes(fixture.dist), before);
    const release = await locatorRelease(locator);
    assert.match(await fileDigest(path.join(fixture.dist, "releases", release, CANDIDATE_MARKER)), /^[a-f0-9]{64}$/);
    assert.equal((await candidateMarker(fixture, locator)).retention, "retained");
  });
});

test("verify-manifest resolves an exact retained candidate without mutating fixture custody", async () => {
  await withFixture(async (fixture) => {
    const locator = await fixture.stage("verify");
    const locatorBytes = await fs.readFile(locator, "utf8");
    const reference = JSON.parse(locatorBytes) as { release_id: string; tree_sha256: string };
    const releasePath = path.join(fixture.dist, "releases", reference.release_id);
    const markerPath = path.join(releasePath, CANDIDATE_MARKER);
    const markerBytes = await fs.readFile(markerPath, "utf8");
    const marker = JSON.parse(markerBytes) as { release_id: string; retention: string; tree_sha256: string };
    assert.deepEqual(
      { release_id: marker.release_id, tree_sha256: marker.tree_sha256, retention: marker.retention },
      { release_id: reference.release_id, tree_sha256: reference.tree_sha256, retention: "retained" },
    );

    const publicationBefore = await publicationBytes(fixture.dist);
    const fixtureBefore = await fixtureTreeIdentity(fixture.root);
    await assert.rejects(fs.stat(path.join(fixture.dist, ".build-lock")), { code: "ENOENT" });
    assert.equal((await fs.readdir(fixture.root)).some((entry) => entry.startsWith(".dist-staging-")), false);

    const verified = await fixture.run(["--verify-manifest", locator]);

    assert.deepEqual(await publicationBytes(fixture.dist), publicationBefore);
    assert.equal(await fs.readFile(locator, "utf8"), locatorBytes);
    assert.equal(await fs.readFile(markerPath, "utf8"), markerBytes);
    assert.deepEqual(await fixtureTreeIdentity(fixture.root), fixtureBefore);
    await assert.rejects(fs.stat(path.join(fixture.dist, ".build-lock")), { code: "ENOENT" });
    assert.equal((await fs.readdir(fixture.root)).some((entry) => entry.startsWith(".dist-staging-")), false);
    assert.equal(verified.code, 0, verified.stderr);
    assert.equal(verified.stderr, "");
    assert.equal(
      verified.stdout,
      `${JSON.stringify({ release_id: reference.release_id, release_path: await fs.realpath(releasePath), tree_sha256: reference.tree_sha256 })}\n`,
    );
  });
});

test("verify-manifest rejects a retained release-directory symlink without mutating fixture custody", async () => {
  await withFixture(async (fixture) => {
    const locator = await fixture.stage("symlinked-release");
    const release = await locatorRelease(locator);
    const releasePath = path.join(fixture.dist, "releases", release);
    const backingPath = path.join(fixture.dist, "releases", `${release}-backing`);
    await fs.rename(releasePath, backingPath);
    await fs.symlink(backingPath, releasePath, "dir");
    const publicationBefore = await publicationBytes(fixture.dist);
    const fixtureBefore = await fixtureTreeIdentity(fixture.root);

    const verified = await fixture.run(["--verify-manifest", locator]);

    assert.notEqual(verified.code, 0);
    assert.equal(verified.stdout, "");
    assert.deepEqual(await publicationBytes(fixture.dist), publicationBefore);
    assert.deepEqual(await fixtureTreeIdentity(fixture.root), fixtureBefore);
    await assert.rejects(fs.stat(path.join(fixture.dist, ".build-lock")), { code: "ENOENT" });
  });
});

test("candidate trees use code-point ordering", async () => {
  await withFixture(async (fixture) => {
    const locator = await fixture.stage("code-points");
    const marker = JSON.parse(
      await fs.readFile(path.join(fixture.dist, "releases", await locatorRelease(locator), CANDIDATE_MARKER), "utf8"),
    ) as { tree: Array<{ path: string }> };
    assert.ok(marker.tree.findIndex((entry) => entry.path === "z.js") < marker.tree.findIndex((entry) => entry.path === "ä.js"));
  });
});

test("a valid staged release survives two ordinary builds and cleanup", async () => {
  await withFixture(async (fixture) => {
    const locator = await fixture.stage("retained");
    const release = await locatorRelease(locator);
    for (let index = 0; index < 2; index += 1) {
      const result = await fixture.run([]);
      assert.equal(result.code, 0, result.stderr);
    }
    const cleaned = await fixture.run(["--clean-inactive"]);
    assert.equal(cleaned.code, 0, cleaned.stderr);
    await fs.stat(path.join(fixture.dist, "releases", release, CANDIDATE_MARKER));
  });
});

test("wrong locators and tampered staged trees block before current changes", async () => {
  await withFixture(async (fixture) => {
    const locator = await fixture.stage("guarded");
    const before = await publicationBytes(fixture.dist);
    const wrongLocator = path.join(fixture.root, "wrong.json");
    const reference = JSON.parse(await fs.readFile(locator, "utf8")) as { release_id: string };
    await fs.writeFile(wrongLocator, JSON.stringify({ release_id: reference.release_id, tree_sha256: "0".repeat(64) }) + "\n", "utf8");
    const wrong = await fixture.run(["--publish-manifest", wrongLocator]);
    assert.notEqual(wrong.code, 0);
    assert.deepEqual(await publicationBytes(fixture.dist), before);
    const missing = await fixture.run(["--publish-manifest", path.join(fixture.root, "missing.json")]);
    assert.notEqual(missing.code, 0);
    assert.deepEqual(await publicationBytes(fixture.dist), before);

    const release = await locatorRelease(locator);
    await fs.appendFile(path.join(fixture.dist, "releases", release, "server.js"), "tampered\n", "utf8");
    const tampered = await fixture.run(["--publish-manifest", locator]);
    assert.notEqual(tampered.code, 0);
    assert.deepEqual(await publicationBytes(fixture.dist), before);
  });
});

test("stage cleans before compiling so a corrupt retained marker cannot cause a post-locator failure", async () => {
  await withFixture(async (fixture) => {
    const retained = await fixture.stage("corrupt-before-stage");
    const retainedRelease = await locatorRelease(retained);
    await fs.writeFile(path.join(fixture.dist, "releases", retainedRelease, CANDIDATE_MARKER), "not json\n", "utf8");
    const before = await publicationBytes(fixture.dist);
    const failedLocator = path.join(fixture.root, "must-not-publish.json");

    const staged = await fixture.run(["--stage-only", "--manifest-out", failedLocator]);
    assert.notEqual(staged.code, 0);
    assert.equal(await fs.readFile(fixture.counter, "utf8"), "1");
    await assert.rejects(fs.stat(failedLocator), { code: "ENOENT" });
    assert.deepEqual(await publicationBytes(fixture.dist), before);
  });
});

test("publish resumes maintenance-window crash cutpoints without rebuilding", async () => {
  await withFixture(async (fixture) => {
    const locator = await fixture.stage("crash-retry");
    const release = await locatorRelease(locator);
    const releaseDir = path.join(fixture.dist, "releases", release);

    // Crash after the current-link switch but before all stable wrappers are published.
    await fs.rm(path.join(fixture.dist, "current"));
    await fs.symlink(path.join("releases", release), path.join(fixture.dist, "current"), "dir");
    await fs.writeFile(path.join(fixture.dist, "server.js"), "stale wrapper\n", "utf8");
    await fs.rm(path.join(fixture.dist, "piChild.js"));
    await fs.writeFile(path.join(fixture.dist, "obsolete.js"), "stale wrapper\n", "utf8");
    await fs.writeFile(path.join(fixture.dist, "operator-note.txt"), "preserve me\n", "utf8");

    const resumed = await fixture.run(["--publish-manifest", locator]);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(await fs.readFile(fixture.counter, "utf8"), "1");
    assert.equal(await fs.readlink(path.join(fixture.dist, "current")), path.join("releases", release));
    for (const entry of ["server.js", "piChild.js", "library.js", "z.js", "ä.js"]) {
      assert.equal(await fs.readFile(path.join(fixture.dist, entry), "utf8"), wrapperBody(entry));
    }
    await assert.rejects(fs.stat(path.join(fixture.dist, "obsolete.js")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(fixture.dist, "operator-note.txt"), "utf8"), "preserve me\n");
    assert.equal((await candidateMarker(fixture, locator)).retention, "retained");

    // Crash after the exact current link and wrappers are complete, before retention changes.
    const complete = await publicationBytes(fixture.dist);
    const retried = await fixture.run(["--publish-manifest", locator]);
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal(await fs.readFile(fixture.counter, "utf8"), "1");
    assert.deepEqual(await publicationBytes(fixture.dist), complete);
    assert.equal((await candidateMarker(fixture, locator)).retention, "retained");
    assert.equal(await fs.readFile(path.join(releaseDir, "server.js"), "utf8"), "export const build = '1';\n");
  });
});

test("publish switches the exact retained tree without rebuilding and releases retention only after a live lease", async () => {
  await withFixture(async (fixture) => {
    const locator = await fixture.stage("publish");
    const release = await locatorRelease(locator);
    const releaseDir = path.join(fixture.dist, "releases", release);
    const stagedServer = await fs.readFile(path.join(releaseDir, "server.js"), "utf8");
    assert.equal(await fs.readFile(fixture.counter, "utf8"), "1");

    const first = await fixture.run(["--publish-manifest", locator]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(await fs.readFile(fixture.counter, "utf8"), "1");
    assert.equal(await fs.readlink(path.join(fixture.dist, "current")), path.join("releases", release));
    assert.equal(await fs.readFile(path.join(releaseDir, "server.js"), "utf8"), stagedServer);
    assert.equal(await fs.readFile(path.join(fixture.dist, "server.js"), "utf8"), wrapperBody("server.js"));
    assert.equal((await candidateMarker(fixture, locator)).retention, "retained");

    await fs.writeFile(path.join(releaseDir, `.subagent007-server-${process.pid}.lease.json`), "{}\n", "utf8");
    const retry = await fixture.run(["--publish-manifest", locator]);
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal(await fs.readFile(fixture.counter, "utf8"), "1");
    assert.equal((await candidateMarker(fixture, locator)).retention, "published");
  });
});


test("release leases are excluded from immutable trees but arbitrary files still block publication", async () => {
  await withFixture(async (fixture) => {
    const locator = await fixture.stage("lease-tree");
    const release = await locatorRelease(locator);
    const releaseDir = path.join(fixture.dist, "releases", release);
    await fs.writeFile(path.join(releaseDir, `.subagent007-server-${process.pid}.lease.json`), "{}\n", "utf8");
    const published = await fixture.run(["--publish-manifest", locator]);
    assert.equal(published.code, 0, published.stderr);

    const arbitrary = await fixture.stage("arbitrary-tree");
    const arbitraryRelease = await locatorRelease(arbitrary);
    const before = await publicationBytes(fixture.dist);
    await fs.writeFile(path.join(fixture.dist, "releases", arbitraryRelease, ".subagent007-server-note.lease.json"), "{}\n", "utf8");
    const blocked = await fixture.run(["--publish-manifest", arbitrary]);
    assert.notEqual(blocked.code, 0);
    assert.deepEqual(await publicationBytes(fixture.dist), before);
  });
});


test("cleanup fails closed when an existing candidate marker is corrupt", async () => {
  await withFixture(async (fixture) => {
    const locator = await fixture.stage("corrupt-marker");
    const release = await locatorRelease(locator);
    const releaseDir = path.join(fixture.dist, "releases", release);
    await fs.writeFile(path.join(releaseDir, CANDIDATE_MARKER), "not json\n", "utf8");
    await fs.mkdir(path.join(fixture.dist, "releases", "9999-12-31T235959999Z-deadbeef"));
    const before = await publicationBytes(fixture.dist);

    const cleaned = await fixture.run(["--clean-inactive"]);
    assert.notEqual(cleaned.code, 0);
    await fs.stat(releaseDir);
    assert.deepEqual(await publicationBytes(fixture.dist), before);
  });
});


test("detached locators reject symlinks, release-custody escapes, absent parents, and non-regular files before compilation", async () => {
  await withFixture(async (fixture) => {
    const target = path.join(fixture.root, "target.json");
    const symlink = path.join(fixture.root, "locator-link.json");
    await fs.writeFile(target, "{}\n", "utf8");
    await fs.symlink(target, symlink);
    const externalParent = path.join(fixture.root, "release-parent");
    await fs.symlink(path.join(fixture.dist, "releases", "seed"), externalParent, "dir");
    const directoryLocator = path.join(fixture.root, "locator-directory");
    await fs.mkdir(directoryLocator);
    const locators = [
      symlink,
      path.join(fixture.dist, "current", "candidate.json"),
      path.join(externalParent, "candidate.json"),
      path.join(fixture.root, "missing-parent", "candidate.json"),
      directoryLocator,
    ];

    for (const locator of locators) {
      const result = await fixture.run(["--stage-only", "--manifest-out", locator]);
      assert.notEqual(result.code, 0, `locator was accepted: ${locator}`);
      await assert.rejects(fs.stat(fixture.counter), { code: "ENOENT" });
    }
  });
});


test("failed locator publication removes the never-current staged release", async () => {
  await withFixture(async (fixture) => {
    const locator = path.join(fixture.root, "x".repeat(245));
    const result = await fixture.run(["--stage-only", "--manifest-out", locator]);
    assert.notEqual(result.code, 0);
    assert.equal(await fs.readFile(fixture.counter, "utf8"), "1");
    assert.deepEqual(await fs.readdir(path.join(fixture.dist, "releases")), ["seed"]);
  });
});

test("abandon is idempotent, permits cleanup, and prevents publication", async () => {
  await withFixture(async (fixture) => {
    const locator = await fixture.stage("abandon");
    const release = await locatorRelease(locator);
    const before = await publicationBytes(fixture.dist);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const abandoned = await fixture.run(["--abandon-manifest", locator]);
      assert.equal(abandoned.code, 0, abandoned.stderr);
    }
    assert.equal((await candidateMarker(fixture, locator)).retention, "abandoned");
    assert.deepEqual(await publicationBytes(fixture.dist), before);
    const publish = await fixture.run(["--publish-manifest", locator]);
    assert.notEqual(publish.code, 0);
    const cleaned = await fixture.run(["--clean-inactive"]);
    assert.equal(cleaned.code, 0, cleaned.stderr);
    await assert.rejects(fs.stat(path.join(fixture.dist, "releases", release)), { code: "ENOENT" });
  });
});

test("locator validation waits for the build lock", async () => {
  await withFixture(async (fixture) => {
    const invalidLocator = path.join(fixture.root, "missing-parent", "candidate.json");
    const child = await startLockedCommand(fixture, ["--stage-only", "--manifest-out", invalidLocator]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(child.exitCode, null, "locator validation escaped the build lock");
    await releaseLock(fixture);
    assert.notEqual(await waitForExit(child), 0);
  });
});

test("stage, cleanup, publish, and abandon all wait for the build lock", async () => {
  await withFixture(async (fixture) => {
    const publishLocator = await fixture.stage("locked-publish");
    const abandonLocator = await fixture.stage("locked-abandon");
    const stageLocator = path.join(fixture.root, "locked-stage.json");
    const operations: Array<{ args: string[]; unchanged: () => Promise<void> }> = [
      {
        args: ["--stage-only", "--manifest-out", stageLocator],
        unchanged: async () => assert.equal(await fs.readFile(fixture.counter, "utf8"), "2"),
      },
      {
        args: ["--clean-inactive"],
        unchanged: async () => assert.equal((await candidateMarker(fixture, abandonLocator)).retention, "retained"),
      },
      {
        args: ["--publish-manifest", publishLocator],
        unchanged: async () => assert.equal(await fs.readlink(path.join(fixture.dist, "current")), path.join("releases", "seed")),
      },
      {
        args: ["--abandon-manifest", abandonLocator],
        unchanged: async () => assert.equal((await candidateMarker(fixture, abandonLocator)).retention, "retained"),
      },
    ];
    for (const operation of operations) {
      const child = await startLockedCommand(fixture, operation.args);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(child.exitCode, null, `operation escaped the build lock: ${operation.args.join(" ")}`);
      await operation.unchanged();
      await releaseLock(fixture);
      assert.equal(await waitForExit(child), 0);
    }
  });
});
