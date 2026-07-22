---
name: runtime-artifact-ownership
description: Prevent disk and build garbage by assigning every runtime artifact an observable owner, successor, and cleanup condition.
last_updated: 2026-07-19
---

# Runtime Artifact Ownership

Use this pattern when adding or changing child output, temporary directories, sockets, build releases, or other local runtime artifacts.

## Invariants

- Canonical public outputs are durable artifacts and are never deleted as garbage by default.
- Private or redundant raw capture is not a durable output. Prefer direct sanitized streaming into the canonical staging artifact.
- Every transient directory records the creating PID and artifact kind. Automatic cleanup requires proof that the owner process is gone.
- A transient artifact is removed immediately after its durable successor is atomically published.
- A protected free-space reserve stops new or active work before the host reaches filesystem exhaustion; it does not silently truncate a continuing run.
- Builds compile away from the runtime-visible release, publish through one atomic pointer switch, and retain any release with a live server lease.

## Verification

1. Prove a transcript larger than the former 256 KiB boundary survives intact.
2. Prove structured projection cannot expose private/raw prefixes.
3. Prove low-disk preflight rejects before child launch and active low-disk detection settles one run without crashing the server.
4. Prove cleanup preserves live-owned and unowned legacy paths while removing stale owned paths.
5. Prove runtime entrypoints remain present during build publication, readiness exposes the lease-owned loaded release and `dist/current` release identities, and an older loaded release is blocked rather than accepted from stable launcher bytes.
