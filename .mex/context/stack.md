---
name: stack
description: Technology stack, library choices, and the reasoning behind them. Load when working with specific technologies or making decisions about libraries and tools.
triggers:
  - "library"
  - "package"
  - "dependency"
  - "which tool"
  - "technology"
edges:
  - target: context/decisions.md
    condition: when the reasoning behind a tech choice is needed
  - target: context/conventions.md
    condition: when understanding how to use a technology in this codebase
last_updated: 2026-07-19
---

# Stack

## Core Technologies
- Node.js `>=22.19.0` - runtime for the MCP server, child wrapper, scripts, and tests.
- TypeScript ESM - source lives in `src/`, emits to `dist/`, package type is `module`.
- `@modelcontextprotocol/sdk` - exposes the server's tool surface and is used by tests to drive protocol behavior.
- Node test runner - tests are `node:test` files run through `scripts/run-tests-with-ledger-guard.mjs`.
- Local filesystem state - no database; persistent operational state lives under `~/.codex/subagent007-pi/` unless overridden.

## Key Libraries
- `@modelcontextprotocol/sdk` - canonical MCP server/client types and transports; do not hand-roll protocol behavior.
- Node built-ins (`fs/promises`, `child_process`, `path`, `crypto`) - filesystem state, detached process execution, and safe id/hash generation.
- TypeScript compiler (`tsc`) - build and static oracle; there is no separate linter configured.
- `@earendil-works/pi-coding-agent` `^0.80.6` - Pi child runtime and model registry, reached through the child request-file contract rather than a direct in-process API.

## What We Deliberately Do NOT Use
- No web framework; the package is an MCP server, not an HTTP app.
- No database/ORM/cache layer; local JSON/JSONL files are the persistence boundary.
- No database-backed or remote job queue; only top-level durable `start_run` and `schedule_run` use the bounded local metadata queue. One-shot, named-session, and recursive launches still reject at capacity.
- No separate lint tool; use `npm run typecheck`, `npm run docs:check`, and tests.
- No concrete public model ids; public callers use model classes `A` through `E` or external expert classes `Z1` through `Z3`.

## Version Constraints
- Node must satisfy `>=22.19.0`.
- Build output in `dist/` must be fresh after `src/` edits before MCP/runtime readiness checks.
- The bundled Pi coding-agent registry must natively contain, or have an explicit source-verified runtime transport fallback for, every concrete model behind classes A-E and Z1-Z3; a newer global `pi` executable does not make an older project-local runtime compatible.
