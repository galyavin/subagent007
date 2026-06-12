Finding 1: `scripts/run-tests-with-ledger-guard.mjs` still couples the default `npm test` oracle to the user-level failure ledger.

Evidence: `package.json` runs `node scripts/run-tests-with-ledger-guard.mjs tests/*.test.ts` without setting `SUBAGENT007_FAILURE_LOG_PATH`. The guard's `defaultFailureLogPath()` falls back to `~/.codex/subagent007-pi/failures.jsonl`, fingerprints that file, and only passes a `SUBAGENT007_RECORD_SOURCE:"test"` override to the child process. This means ordinary `npm test` can fail because another process writes to the production Subagent007 failure ledger during the test window, even when this repo's tests are isolated and correct. The 2026-06-12 simplification report records the same ambient-ledger constraint after Loop 93, so this is not hypothetical.

Impact: test-oracle incoherence. Product behavior is unaffected, but the repository's primary test command is not fully self-contained and can report a false repository failure due to unrelated production-state mutation.

Risk-free repair target: when no `SUBAGENT007_FAILURE_LOG_PATH` is inherited, the guard should allocate a private temporary failure ledger path and pass it to the child tests, then fingerprint that private path. When the caller explicitly provides `SUBAGENT007_FAILURE_LOG_PATH`, the guard should preserve and guard that path exactly as it does today.
