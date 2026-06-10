import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { stripAnsiAndControls } from "../src/output.js";
import { resolvePiAgentDir } from "../src/piAgentDir.js";
import { composePrompt } from "../src/prompt.js";
import { computeTimeoutBudget } from "../src/timeoutBudget.js";
import { ValidationError } from "../src/types.js";
import { validateAndResolveRequest, validateSkillName } from "../src/validate.js";
import { withEnv } from "./helpers/testUtils.js";

test("loads Pi runner config defaults from JSON and ignores unknown keys", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-config-"));
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      default_model: "openai-codex/gpt-5.4-mini",
      default_thinking_level: "medium",
      unknown_key: "ignored",
    }),
  );

  assert.deepEqual(await loadConfig(configPath), {
    default_model: "openai-codex/gpt-5.4-mini",
    default_thinking_level: "medium",
  });
});

test("rejects unsupported config thinking levels", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-config-"));
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ default_model: "openai-codex/gpt-5.4-mini", default_thinking_level: "minimal" }),
  );

  await assert.rejects(loadConfig(configPath), /default_thinking_level must be one of: low, medium, high, xhigh/);
});

test("missing config file is allowed until defaults are needed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-missing-config-"));
  assert.deepEqual(await loadConfig(path.join(dir, "missing.json")), {});
});

test("resolves Pi agent directory from env with the Pi default fallback", async () => {
  await withEnv({ SUBAGENT007_PI_AGENT_DIR: undefined, PI_CODING_AGENT_DIR: undefined }, async () => {
    assert.equal(resolvePiAgentDir(), path.join(os.homedir(), ".pi", "agent"));
  });

  await withEnv({ SUBAGENT007_PI_AGENT_DIR: " ./isolated-pi-agent ", PI_CODING_AGENT_DIR: undefined }, async () => {
    assert.equal(resolvePiAgentDir(), path.resolve("./isolated-pi-agent"));
  });

  await withEnv({ SUBAGENT007_PI_AGENT_DIR: undefined, PI_CODING_AGENT_DIR: " ~/.pi-alt/agent " }, async () => {
    assert.equal(resolvePiAgentDir(), path.join(os.homedir(), ".pi-alt", "agent"));
  });

  await withEnv({ SUBAGENT007_PI_AGENT_DIR: "/explicit", PI_CODING_AGENT_DIR: "/native" }, async () => {
    assert.equal(resolvePiAgentDir(), "/explicit");
  });
});

test("resolves caller fields over config defaults", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-cwd-"));
  const resolved = await validateAndResolveRequest(
    {
      prompt: "  say hi  ",
      cwd,
      continuity: { mode: "resume", session_id: "  /tmp/session.jsonl  " },
      model: "openai-codex/gpt-5.4-mini",
      thinking_level: "high",
      skill: "pda-lite",
    },
    { default_model: "ignored", default_thinking_level: "low" },
  );

  assert.equal(resolved.prompt, "say hi");
  assert.deepEqual(resolved.continuity, { mode: "resume", session_id: "/tmp/session.jsonl" });
  assert.equal(resolved.model, "openai-codex/gpt-5.4-mini");
  assert.equal(resolved.thinkingLevel, "high");
  assert.equal(resolved.skill, "pda-lite");
  assert.equal(resolved.outputMode, "final");
});

test("accepts curated model refs and compatible unqualified aliases", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-model-"));
  for (const model of [
    "gpt-5.4",
    "openai-codex/gpt-5.4-mini",
    "openai-codex/gpt-5.5",
    "gemma4:12b",
    "ollama/gemma4:12b",
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    "openrouter/deepseek/deepseek-v4-pro",
    "~anthropic/claude-sonnet-latest",
    "openrouter/~anthropic/claude-sonnet-latest",
  ]) {
    const resolved = await validateAndResolveRequest(
      { prompt: "x", cwd, model, thinking_level: "medium" },
      {},
    );
    assert.equal(resolved.model, model);
  }
});

test("repairs known stale model aliases to curated model refs", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-model-repair-"));
  const resolved = await validateAndResolveRequest(
    {
      prompt: "x",
      cwd,
      model: "openrouter/anthropic/claude-sonnet-4.5",
      thinking_level: "medium",
    },
    {},
  );
  assert.equal(resolved.model, "openrouter/~anthropic/claude-sonnet-latest");
});

test("rejects models outside the curated allowlist", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-model-"));
  await assert.rejects(
    validateAndResolveRequest(
      { prompt: "x", cwd, model: "anthropic/claude-opus-4-5", thinking_level: "medium" },
      {},
    ),
    /curated Subagent007 Pi allowlist/,
  );
  await assert.rejects(
    validateAndResolveRequest(
      { prompt: "x", cwd, model: "openai-codex/gpt-5.3-codex", thinking_level: "medium" },
      {},
    ),
    /curated Subagent007 Pi allowlist/,
  );
  await assert.rejects(
    validateAndResolveRequest(
      { prompt: "x", cwd, model: "deepseek/deepseek-v4-flash:free", thinking_level: "medium" },
      {},
    ),
    /curated Subagent007 Pi allowlist/,
  );
});

test("computes an effective child timeout within the requested hard cap", () => {
  assert.deepEqual(
    computeTimeoutBudget(120000, {
      responseHeadroomMs: 5000,
      killGraceMs: 1000,
      forceGraceMs: 1000,
    }),
    {
      requestedTimeoutMs: 120000,
      resolvedTimeoutMs: 120000,
      minRequestedTimeoutMs: 0,
      effectiveTimeoutMs: 113000,
      responseHeadroomMs: 5000,
      killGraceMs: 1000,
      forceGraceMs: 1000,
    },
  );
  assert.equal(computeTimeoutBudget(undefined).effectiveTimeoutMs, null);
  assert.equal(computeTimeoutBudget(undefined).resolvedTimeoutMs, null);
});

test("rejects invalid preflight input before any child spawn is possible", async () => {
  await assert.rejects(
    validateAndResolveRequest(
      { prompt: "x", cwd: "relative", model: "openai-codex/gpt-5.4-mini", thinking_level: "medium" },
      {},
    ),
    ValidationError,
  );

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-cwd-"));
  await assert.rejects(
    validateAndResolveRequest({ prompt: "", cwd, model: "openai-codex/gpt-5.4-mini", thinking_level: "medium" }, {}),
    ValidationError,
  );

  await assert.rejects(validateAndResolveRequest({ prompt: "x", cwd }, {}), /default_model/);

  await assert.rejects(
    validateAndResolveRequest(
      { prompt: "x", cwd, model: "openai-codex/gpt-5.4-mini", thinking_level: "minimal" as never },
      {},
    ),
    /thinking_level must be one of: low, medium, high, xhigh/,
  );

  await assert.rejects(
    validateAndResolveRequest(
      {
        prompt: "x",
        cwd,
        session_id: "0",
        model: "openai-codex/gpt-5.4-mini",
        thinking_level: "medium",
      } as never,
      {},
    ),
    /session_id is not a run_subagent input/,
  );

  await assert.rejects(
    validateAndResolveRequest(
      {
        prompt: "x",
        cwd,
        continuity: { mode: "fresh", session_id: "/tmp/session.jsonl" } as never,
        model: "openai-codex/gpt-5.4-mini",
        thinking_level: "medium",
      },
      {},
    ),
    /continuity.session_id is only valid/,
  );
});

test("validates bare skill identifiers only", () => {
  for (const skill of ["pda-lite", "google-drive:google-docs", "compound-engineering:ce-work"]) {
    assert.equal(validateSkillName(skill), skill);
  }

  for (const skill of [
    "$pda-lite",
    "[$pda-lite](/path/SKILL.md)",
    "/Users/rgalyavin/.codex/skills/pda-lite/SKILL.md",
    "use pda-lite",
    "pda-lite\nentropy-seeker",
    " pda-lite ",
    "plugin:skill:extra",
  ]) {
    assert.throws(() => validateSkillName(skill), ValidationError, skill);
  }
});

test("composes Pi skill invocation without wrapping ordinary prompts", () => {
  assert.equal(composePrompt({ prompt: "Do it" }), "Do it");
  assert.equal(
    composePrompt({ prompt: "Do it", skill: "pda-lite" }),
    ["/skill:pda-lite", "", "<prompt>", "Do it", "</prompt>"].join("\n"),
  );
});

test("strips ANSI escape and control codes for Markdown output", () => {
  const cleaned = stripAnsiAndControls("\u001b[31mred\u001b[0m\0\nnext");
  assert.equal(cleaned, "red\nnext");
});
