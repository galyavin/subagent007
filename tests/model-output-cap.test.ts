import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelWithOutputTokenCap } from "../src/modelOutputCap.js";

const execFileAsync = promisify(execFile);

function openRouterModel(id: string, maxTokens: number): Model<Api> {
  return {
    provider: "openrouter",
    id,
    name: `fixture ${id}`,
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    maxTokens,
    contextWindow: 1_048_576,
    input: ["text"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as Model<Api>;
}

test("request output cap clones the transport model without changing its advertised maximum", () => {
  const model = {
    provider: "openrouter",
    id: "example/model",
    maxTokens: 262_144,
  } as Model<Api>;

  const capped = modelWithOutputTokenCap(model, 32_768);

  assert.notEqual(capped, model);
  assert.equal(capped.maxTokens, 32_768);
  assert.equal(model.maxTokens, 262_144);
});

test("request output cap never raises a concrete model maximum", () => {
  const model = {
    provider: "openrouter",
    id: "example/model",
    maxTokens: 65_536,
  } as Model<Api>;

  assert.equal(modelWithOutputTokenCap(model, 100_000).maxTokens, 65_536);
  assert.equal(modelWithOutputTokenCap(model).maxTokens, 65_536);
});

test("loaded Pi OpenRouter transport emits the capped Z2 and Z3 completion allowance", async () => {
  const models = [
    modelWithOutputTokenCap(openRouterModel("qwen/qwen3.8-2.4t-a95b", 131_072), 32_768),
    modelWithOutputTokenCap(openRouterModel("x-ai/grok-4.7", 450_000), 32_768),
  ];
  const script = `
    import fs from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { ModelRuntime, createAgentSession } from "@earendil-works/pi-coding-agent";
    const models = ${JSON.stringify(models)};
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-payload-cap-"));
    const cwd = path.join(root, "cwd");
    const agentDir = path.join(root, "agent");
    await fs.mkdir(cwd); await fs.mkdir(agentDir);
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null });
    await modelRuntime.setRuntimeApiKey("openrouter", "offline-fixture-key");
    const payloads = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      const chunks = [
        { id: "offline-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
        { id: "offline-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      return new Response(chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\\n\\n").join("") + "data: [DONE]\\n\\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    let session;
    try {
      ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: models[0], thinkingLevel: "xhigh", tools: [] }));
      await session.prompt("Z2 offline payload fixture");
      await session.setModel(models[1]);
      await session.prompt("Z3 offline payload fixture");
      console.log(JSON.stringify(payloads.map((payload) => ({ model: payload.model, max_completion_tokens: payload.max_completion_tokens, reasoning: payload.reasoning }))));
    } finally {
      session?.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    timeout: 10_000,
  });
  const payloads = JSON.parse(stdout) as Array<Record<string, unknown>>;
  assert.deepEqual(
    payloads.map((payload) => [payload.model, payload.max_completion_tokens, payload.reasoning]),
    [
      ["qwen/qwen3.8-2.4t-a95b", 32_768, { effort: "high" }],
      ["x-ai/grok-4.7", 32_768, { effort: "high" }],
    ],
  );
  assert.equal(payloads.every((payload) => Object.hasOwn(payload, "max_tokens") === false), true);
});
