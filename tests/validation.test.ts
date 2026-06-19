import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfigPath, loadConfig, loadConfigRecord } from "../src/config.js";
import { modelHealthForClass } from "../src/modelHealth.js";
import { stripAnsiAndControls, writeRunOutput } from "../src/output.js";
import { resolvePiAgentDir } from "../src/piAgentDir.js";
import { composePrompt } from "../src/prompt.js";
import { ValidationError } from "../src/types.js";
import { validateAndResolveRequest, validateSkillName } from "../src/validate.js";
import { withEnv } from "./helpers/testUtils.js";

const TIMESTAMPED_OUTPUT_BASENAME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{9}Z-[0-9a-f]{12}\.md$/;

test("config path uses the shared Subagent007 state path shape", async () => {
  await withEnv({ SUBAGENT007_CONFIG_PATH: undefined }, async () => {
    assert.equal(defaultConfigPath(), path.join(os.homedir(), ".codex", "subagent007-pi", "config.json"));
  });

  await withEnv({ SUBAGENT007_CONFIG_PATH: " ./custom-config.json " }, async () => {
    assert.equal(defaultConfigPath(), path.resolve(" ./custom-config.json "));
  });
});

test("loads Pi runner config defaults from JSON and ignores unknown keys", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-config-"));
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      default_model_class: "C",
      unknown_key: "ignored",
    }),
  );

  assert.deepEqual(await loadConfig(configPath), {
    default_model_class: "C",
  });
});

test("raw config records preserve persisted values while runtime config normalizes them", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-config-raw-"));
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      default_model_class: " C ",
    }),
  );

  assert.deepEqual(await loadConfigRecord(configPath), {
    default_model_class: " C ",
  });
  assert.deepEqual(await loadConfig(configPath), {
    default_model_class: "C",
  });
});

test("legacy default model and thinking config maps to default model class", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-config-legacy-"));
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      default_model: "openai-codex/gpt-5.4-mini",
      default_thinking_level: "high",
    }),
  );

  assert.deepEqual(await loadConfig(configPath), {
    default_model_class: "C",
  });
});

test("malformed legacy model config does not block class defaults", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-config-legacy-malformed-"));
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      default_model: 42,
      default_thinking_level: "ultra",
    }),
  );

  const config = await loadConfig(configPath);
  assert.deepEqual(config, {});

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-cwd-"));
  const resolved = await validateAndResolveRequest({ prompt: "x", cwd }, config);
  assert.equal(resolved.modelClass, "C");
  assert.equal(resolved.model, "openai-codex/gpt-5.4-mini");
  assert.equal(resolved.thinkingLevel, "high");
});

test("model health records reject unsupported model classes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-model-health-"));
  const healthPath = path.join(dir, "model-health.json");
  await fs.writeFile(
    healthPath,
    JSON.stringify([
      {
        schema_version: 1,
        model_class: "Z",
        resolved_model: "openai-codex/gpt-5.4-mini",
        surface: "run_subagent_one_shot",
        checked_at: "2026-06-11T00:00:00.000Z",
        usable_for_one_shot: true,
      },
    ]),
  );

  await assert.rejects(
    modelHealthForClass("C", { healthPath }),
    /model health record model_class is invalid/,
  );
});

test("model health records require nonempty string fields", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-model-health-fields-"));
  const healthPath = path.join(dir, "model-health.json");
  const baseRecord = {
    schema_version: 1,
    model_class: "C",
    resolved_model: "openai-codex/gpt-5.4-mini",
    surface: "run_subagent_one_shot",
    checked_at: "2026-06-11T00:00:00.000Z",
    usable_for_one_shot: true,
  };

  await fs.writeFile(
    healthPath,
    JSON.stringify([{ ...baseRecord, resolved_model: " " }]),
  );
  await assert.rejects(
    modelHealthForClass("C", { healthPath }),
    /model health record resolved_model must be a nonempty string/,
  );

  await fs.writeFile(
    healthPath,
    JSON.stringify([{ ...baseRecord, checked_at: "" }]),
  );
  await assert.rejects(
    modelHealthForClass("C", { healthPath }),
    /model health record checked_at must be a nonempty string/,
  );
});

test("rejects unsupported config model classes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-config-"));
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ default_model_class: "Z" }),
  );

  await assert.rejects(loadConfig(configPath), /default_model_class must be one of: A, B, C, D, E/);
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
  const sessionFile = path.join(cwd, "session.jsonl");
  await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session" })}\n`);
  const resolved = await validateAndResolveRequest(
    {
      prompt: "  say hi  ",
      cwd,
      continuity: { mode: "resume", session_id: `  ${sessionFile}  ` },
      model_class: "D",
      skill_name: "pda-lite",
      tool_profile: "workspace_write",
    },
    { default_model_class: "A" },
  );

  assert.equal(resolved.prompt, "say hi");
  assert.deepEqual(resolved.continuity, { mode: "resume", session_id: sessionFile });
  assert.equal(resolved.modelClass, "D");
  assert.equal(resolved.model, "openai-codex/gpt-5.5");
  assert.equal(resolved.thinkingLevel, "high");
  assert.equal(resolved.skill, "pda-lite");
  assert.equal(resolved.outputMode, "final");
  assert.equal(resolved.toolProfile, "all");
});

test("resolves canonical skill_name and legacy skill alias", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-skill-name-"));

  const canonical = await validateAndResolveRequest(
    {
      prompt: "x",
      cwd,
      model_class: "C",
      skill_name: "pda-lite",
    },
    {},
  );
  assert.equal(canonical.skill, "pda-lite");

  const legacy = await validateAndResolveRequest(
    {
      prompt: "x",
      cwd,
      model_class: "C",
      skill: "pda-lite",
    },
    {},
  );
  assert.equal(legacy.skill, "pda-lite");

  const bothSame = await validateAndResolveRequest(
    {
      prompt: "x",
      cwd,
      model_class: "C",
      skill_name: "pda-lite",
      skill: "pda-lite",
    },
    {},
  );
  assert.equal(bothSame.skill, "pda-lite");

  const nullSkill = await validateAndResolveRequest(
    {
      prompt: "x",
      cwd,
      model_class: "C",
      skill_name: null,
      skill: null,
    },
    {},
  );
  assert.equal(nullSkill.skill, undefined);

  await assert.rejects(
    validateAndResolveRequest(
      {
        prompt: "x",
        cwd,
        model_class: "C",
        skill_name: "pda-lite",
        skill: "tension-hunter",
      },
      {},
    ),
    /skill and skill_name must match/,
  );
});

test("rejects leading skill invocation syntax in unbound prompts", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-prompt-skill-"));
  const base = {
    cwd,
    model_class: "C" as const,
  };

  for (const prompt of [
    "/skill:tension-hunter\nFind the load-bearing tension.",
    "$tension-hunter\nFind the load-bearing tension.",
    "[$tension-hunter](/Users/rgalyavin/.codex/skills/tension-hunter/SKILL.md)\nFind it.",
    "use $tension-hunter on this plan",
    "run $google-drive:google-docs on this doc",
    "invoke $compound-engineering:ce-work now",
  ]) {
    await assert.rejects(
      validateAndResolveRequest({ ...base, prompt }, {}),
      /Pass skill_name instead of putting skill invocation syntax in prompt/,
      prompt,
    );
  }

  const ordinary = await validateAndResolveRequest(
    {
      ...base,
      prompt: "Analyze this literal example: /skill:tension-hunter is not the requested invocation.",
    },
    {},
  );
  assert.equal(ordinary.skill, undefined);

  const bound = await validateAndResolveRequest(
    {
      ...base,
      prompt: "$tension-hunter\nFind the load-bearing tension.",
      skill_name: "tension-hunter",
    },
    {},
  );
  assert.equal(bound.skill, "tension-hunter");
});

test("validates resume session files before spawning Pi work", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-resume-file-"));
  const validSession = path.join(cwd, "session.jsonl");
  await fs.writeFile(validSession, `${JSON.stringify({ type: "session" })}\n`);
  const valid = await validateAndResolveRequest(
    {
      prompt: "x",
      cwd,
      continuity: { mode: "resume", session_id: validSession },
      model_class: "C",
    },
    {},
  );
  assert.deepEqual(valid.continuity, { mode: "resume", session_id: validSession });

  await assert.rejects(
    validateAndResolveRequest(
      {
        prompt: "x",
        cwd,
        continuity: { mode: "resume", session_id: "relative-session.jsonl" },
        model_class: "C",
      },
      {},
    ),
    /continuity.session_id must be an absolute path/,
  );
  await assert.rejects(
    validateAndResolveRequest(
      {
        prompt: "x",
        cwd,
        continuity: { mode: "resume", session_id: path.join(cwd, "missing.jsonl") },
        model_class: "C",
      },
      {},
    ),
    /resume session file does not exist/,
  );
  await assert.rejects(
    validateAndResolveRequest(
      {
        prompt: "x",
        cwd,
        continuity: { mode: "resume", session_id: cwd },
        model_class: "C",
      },
      {},
    ),
    /resume session path is not a file/,
  );

  const emptySession = path.join(cwd, "empty.jsonl");
  await fs.writeFile(emptySession, "");
  await assert.rejects(
    validateAndResolveRequest(
      {
        prompt: "x",
        cwd,
        continuity: { mode: "resume", session_id: emptySession },
        model_class: "C",
      },
      {},
    ),
    /resume session file is empty/,
  );
});

test("resolves tool profile to all while accepting legacy explicit profiles", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-tool-profile-"));
  const defaulted = await validateAndResolveRequest(
    { prompt: "x", cwd, model_class: "C" },
    {},
  );
  assert.equal(defaulted.toolProfile, "all");

  for (const toolProfile of ["all", "inspect", "web_search", "shell", "workspace_write"] as const) {
    const resolved = await validateAndResolveRequest(
      {
        prompt: "x",
        cwd,
        model_class: "C",
        tool_profile: toolProfile,
      },
      {},
    );
    assert.equal(resolved.toolProfile, "all");
  }

  await assert.rejects(
    validateAndResolveRequest(
      {
        prompt: "x",
        cwd,
        model_class: "C",
        tool_profile: "write_only" as never,
      },
      {},
    ),
    /tool_profile must be one of: all, inspect, web_search, shell, workspace_write/,
  );
});

test("resolves model classes to calibrated model and thinking level", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-model-"));
  for (const [modelClass, model, thinkingLevel] of [
    ["A", "openrouter/qwen/qwen3.6-35b-a3b", "high"],
    ["B", "openrouter/deepseek/deepseek-v4-flash", "high"],
    ["C", "openai-codex/gpt-5.4-mini", "high"],
    ["D", "openai-codex/gpt-5.5", "high"],
    ["E", "openai-codex/gpt-5.5", "xhigh"],
  ] as const) {
    const resolved = await validateAndResolveRequest(
      { prompt: "x", cwd, model_class: modelClass },
      {},
    );
    assert.equal(resolved.modelClass, modelClass);
    assert.equal(resolved.model, model);
    assert.equal(resolved.thinkingLevel, thinkingLevel);
  }
});

test("rejects invalid model class and old public model fields", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-model-"));
  await assert.rejects(
    validateAndResolveRequest(
      { prompt: "x", cwd, model_class: "Z" as never },
      {},
    ),
    /model_class must be one of: A, B, C, D, E/,
  );
  await assert.rejects(
    validateAndResolveRequest(
      { prompt: "x", cwd, model: "openai-codex/gpt-5.4-mini" } as never,
      {},
    ),
    /model is no longer a public input/,
  );
  await assert.rejects(
    validateAndResolveRequest(
      { prompt: "x", cwd, thinking_level: "high" } as never,
      {},
    ),
    /thinking_level is calibrated by model_class/,
  );
});

test("rejects invalid preflight input before any child spawn is possible", async () => {
  await assert.rejects(
    validateAndResolveRequest(
      { prompt: "x", cwd: "relative", model_class: "C" },
      {},
    ),
    ValidationError,
  );

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-cwd-"));
  await assert.rejects(
    validateAndResolveRequest({ prompt: "", cwd, model_class: "C" }, {}),
    ValidationError,
  );

  const defaulted = await validateAndResolveRequest({ prompt: "x", cwd }, {});
  assert.equal(defaulted.modelClass, "C");

  await assert.rejects(
    validateAndResolveRequest(
      { prompt: "x", cwd, model_class: "minimal" as never },
      {},
    ),
    /model_class must be one of: A, B, C, D, E/,
  );

  await withEnv(
    {
      SUBAGENT007_MIN_REQUESTED_TIMEOUT_MS: undefined,
      SUBAGENT007_TIMEOUT_RESPONSE_HEADROOM_MS: undefined,
      SUBAGENT007_TIMEOUT_KILL_GRACE_MS: undefined,
      SUBAGENT007_TIMEOUT_FORCE_GRACE_MS: undefined,
    },
    async () => {
      await assert.rejects(
        validateAndResolveRequest(
          {
            prompt: "x",
            cwd,
            model_class: "C",
            timeout_ms: 7000,
          },
          {},
        ),
        /timeout_ms must be at least 7001 ms/,
      );
    },
  );

  await assert.rejects(
    validateAndResolveRequest(
      {
        prompt: "x",
        cwd,
        session_id: "0",
        model_class: "C",
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
        continuity: { mode: "invalid" as never },
        model_class: "C",
      },
      {},
    ),
    /continuity.mode must be one of: ephemeral, fresh, resume/,
  );

  await assert.rejects(
    validateAndResolveRequest(
      {
        prompt: "x",
        cwd,
        continuity: { mode: "fresh", session_id: "/tmp/session.jsonl" } as never,
        model_class: "C",
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
  assert.equal(validateSkillName(null), undefined);

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

test("run output filenames use the timestamped safe-id shape", async () => {
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-pi-output-name-"));
  const output = await writeRunOutput("content", runsDir);

  assert.equal(path.dirname(output.outputPath), runsDir);
  assert.match(path.basename(output.outputPath), TIMESTAMPED_OUTPUT_BASENAME_PATTERN);
});
