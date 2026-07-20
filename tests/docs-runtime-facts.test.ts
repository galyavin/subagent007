import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = "scripts/check-docs-runtime-facts.mjs";

const MODEL_SOURCE = `import type { ModelClass, ThinkingLevel } from "./types.js";

export const MODEL_CLASS_CALIBRATIONS: Record<ModelClass, {
  model: string;
  thinkingLevel: ThinkingLevel;
  description: string;
}> = {
  A: {
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "low",
    description: "A",
  },
  B: {
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "medium",
    description: "B",
  },
  C: {
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "xhigh",
    description: "C",
  },
  D: {
    model: "openai-codex/gpt-5.6-terra",
    thinkingLevel: "high",
    description: "D",
  },
  E: {
    model: "openai-codex/gpt-5.6-sol",
    thinkingLevel: "high",
    description: "E",
  },
  Z1: {
    model: "openrouter/moonshotai/kimi-k3",
    thinkingLevel: "xhigh",
    description: "Z1",
  },
  Z2: {
    model: "openrouter/anthropic/claude-opus-4.8",
    thinkingLevel: "xhigh",
    description: "Z2",
  },
  Z3: {
    model: "openrouter/z-ai/glm-5.2",
    thinkingLevel: "xhigh",
    description: "Z3",
  },
};
`;

function fixtureReadme(envKeys: string[]): string {
  const envText = envKeys.map((key) => `\`${key}\``).join(", ");
  return `# Fixture

| Class | Use when |
| --- | --- |
| \`A\` | A |
| \`B\` | B |
| \`C\` | C |
| \`D\` | D |
| \`E\` | E |
| \`Z1\` | Z1 |
| \`Z2\` | Z2 |
| \`Z3\` | Z3 |

Environment overrides:

- Runtime: ${envText}
`;
}

async function createFixture(options: {
  readmeEnvKeys: string[];
  sourceText: string;
}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-docs-facts-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), fixtureReadme(options.readmeEnvKeys), "utf8");
  await fs.writeFile(path.join(root, "src", "modelAllowlist.ts"), MODEL_SOURCE, "utf8");
  await fs.writeFile(path.join(root, "src", "envUse.ts"), options.sourceText, "utf8");
  await fs.writeFile(path.join(root, "scripts", "noop.mjs"), "\n", "utf8");
  return root;
}

async function runDocsCheck(args: string[] = []): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const result = await execFileAsync(process.execPath, [SCRIPT_PATH, ...args], {
      cwd: process.cwd(),
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

test("README volatile runtime facts match source constants", async () => {
  const result = await runDocsCheck();
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
});

test("docs runtime fact guard ignores env-shaped sentinel strings", async () => {
  const root = await createFixture({
    readmeEnvKeys: ["SUBAGENT007_REAL_KEY"],
    sourceText: `
      const expectedReply = "SUBAGENT007_HEALTH_OK";
      const value = process.env.SUBAGENT007_REAL_KEY;
      void expectedReply;
      void value;
    `,
  });
  const result = await runDocsCheck(["--root", root]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
});

test("docs runtime fact guard fails when source env key is missing from README", async () => {
  const root = await createFixture({
    readmeEnvKeys: [],
    sourceText: "const value = process.env.SUBAGENT007_ONLY_IN_SOURCE; void value;\n",
  });
  const result = await runDocsCheck(["--root", root]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /README is missing runtime\/script environment keys/);
  assert.match(result.stderr, /SUBAGENT007_ONLY_IN_SOURCE/);
});

test("docs runtime fact guard fails when README documents stale env key", async () => {
  const root = await createFixture({
    readmeEnvKeys: ["SUBAGENT007_STALE_KEY"],
    sourceText: "\n",
  });
  const result = await runDocsCheck(["--root", root]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /README documents environment keys not used by runtime\/script source/);
  assert.match(result.stderr, /SUBAGENT007_STALE_KEY/);
});

test("docs runtime fact guard fails when README publishes internal model calibration", async () => {
  const root = await createFixture({
    readmeEnvKeys: [],
    sourceText: "\n",
  });
  await fs.appendFile(
    path.join(root, "README.md"),
    "\nInternal detail that should not be public: openai-codex/gpt-5.6-luna\n",
    "utf8",
  );
  const result = await runDocsCheck(["--root", root]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /README publishes internal model calibration values/);
  assert.match(result.stderr, /openai-codex\/gpt-5\.6-luna/);
});
