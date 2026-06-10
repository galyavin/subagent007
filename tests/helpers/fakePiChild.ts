import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface FakePiDirs {
  childPath: string;
  logPath: string;
}

export async function createFakePiChild(tmpPrefix = "subagent007-fake-pi-"): Promise<FakePiDirs> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), tmpPrefix));
  const childPath = path.join(tmp, "fake-pi-child.cjs");
  const logPath = path.join(tmp, "fake-pi-child.jsonl");
  await fs.writeFile(
    childPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "const path = require('path');",
      "const { spawn } = require('child_process');",
      "const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));",
      "const logPath = process.env.FAKE_PI_LOG_PATH;",
      "if (logPath) fs.appendFileSync(logPath, JSON.stringify({ request }) + '\\n');",
      "function writeEvent(event) { process.stdout.write(JSON.stringify(event) + '\\n'); }",
      "function writeFinal(text) {",
      "  if (request.outputLastMessagePath && request.outputMode === 'final') fs.writeFileSync(request.outputLastMessagePath, text);",
      "  else process.stdout.write(text);",
      "}",
      "function sessionFileForFresh() {",
      "  if (!request.sessionDir) return null;",
      "  fs.mkdirSync(request.sessionDir, { recursive: true });",
      "  const sessionFile = path.join(request.sessionDir, 'fake-pi-session.jsonl');",
      "  fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'fake-pi-session' }) + '\\n');",
      "  return sessionFile;",
      "}",
      "let sessionFile = null;",
      "if (request.sessionMode === 'fresh' && !request.prompt.includes('NO_SESSION')) sessionFile = sessionFileForFresh();",
      "if (request.sessionMode === 'resume') sessionFile = request.sessionFile;",
      "if (sessionFile && !request.prompt.includes('OMIT_SESSION_EVENT')) writeEvent({ type: 'subagent007.session', session_id: sessionFile, session_file: sessionFile, pi_session_id: 'fake-pi-session-id' });",
      "if (request.prompt.includes('TIMEOUT_SPAWN_CHILD')) {",
      "  process.on('SIGTERM', () => {});",
      "  const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
      "  fs.writeFileSync(path.join(request.cwd, 'child.pid'), String(child.pid));",
      "  process.stdout.write('TIMEOUT START\\n' + 'A'.repeat(200000) + '\\n');",
      "  setInterval(() => {}, 1000);",
      "} else if (request.prompt.includes('HEARTBEAT_SLEEP')) {",
      "  setTimeout(() => writeFinal('HEARTBEAT DONE'), 160);",
      "} else if (request.prompt.includes('CANCEL_WAIT')) {",
      "  setInterval(() => {}, 1000);",
      "} else if (request.prompt.includes('FAIL_EXIT')) {",
      "  process.stderr.write('FAKE PI FAILURE\\n');",
      "  process.exit(42);",
      "} else if (request.prompt.includes('ECHO_REQUEST')) {",
      "  writeFinal(JSON.stringify(request));",
      "} else if (request.prompt.includes('RAW_THINKING_TRANSCRIPT')) {",
      "  writeEvent({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'user prompt' }] } });",
      "  writeEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'SECRET_THINKING_SHOULD_NOT_LEAK' } });",
      "  writeEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'PUBLIC ASSISTANT TEXT' }] } });",
      "} else {",
      "  writeFinal(request.prompt.includes('PACKET_VALID') ? '```contract_packet_v1\\n{\"verdict\":\"ready\",\"summary\":\"ok\",\"findings\":[],\"blockers\":[],\"next_step\":\"done\"}\\n```' : 'FAST FINAL');",
      "}",
      "",
    ].join("\n"),
  );
  await fs.chmod(childPath, 0o755);
  return { childPath, logPath };
}
