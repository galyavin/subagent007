---
name: runtime-artifact-ownership
description: Prevent disk and build garbage by assigning every runtime artifact an observable owner, successor, and cleanup condition.
last_updated: 2026-07-26
---

# Runtime Artifact Ownership

Use this pattern when adding or changing child output, temporary directories, sockets, build releases, or other local runtime artifacts.

## Invariants

- Canonical public outputs are durable artifacts and are never deleted as garbage by default.
- A terminal output reference is emitted only after one retained no-follow regular single-link descriptor has exact descriptor/path identity around the pre-rename boundary, then post-rename `S0` is bounded-read and hashed with short-read rejection, exact stable regular single-link `S1` is observed, and the final pathname is proven to name `S1`. Emit only `S1` size/SHA-256 and one root-relative canonical basename; never return or persist an output root as authority. This is a bounded point-in-time final-state witness, not a lock against later mutation.
- Private or redundant raw capture is not a durable output. Prefer direct sanitized streaming into the canonical staging artifact.
- Every transient directory records the creating PID and artifact kind. Automatic cleanup requires proof that the owner process is gone.
- A transient artifact is removed immediately after its durable successor is atomically published.
- When one terminal result requires multiple public files, prepare and witness all files first, persist their exact private ownership before the first non-atomic publish, and clear that ownership only in the terminal commit that references the complete set. Consumers select references by their exact role name, never array position or single-reference cardinality. Owner-loss cleanup must remove staged and partially published members; failed cleanup keeps a retryable durable owner rather than an orphan.
- A protected free-space reserve stops new or active work before the host reaches filesystem exhaustion; it does not silently truncate a continuing run.
- Builds compile away from the runtime-visible release, publish through one atomic pointer switch, and retain any release with a live server lease.

## Verification

1. Prove a transcript larger than the former 256 KiB boundary survives intact while 1 MiB + 1 fails in both streaming and restart recovery.
2. Prove structured projection cannot expose private/raw prefixes.
3. Prove low-disk preflight rejects before child launch and active low-disk detection settles one run without crashing the server.
4. Prove cleanup preserves live-owned and unowned legacy paths while removing stale owned paths.
5. Prove descriptor finalization/recovery reject symlink, directory, FIFO, hardlink, pre-rename same-inode rewrite, pathname replacement, post-read mutation, oversize/growth, and declared size/digest mismatch; prove a rename-window rewrite emits the exact final bytes' digest and ordinary rename ctime changes succeed.
6. Prove runtime entrypoints remain present during build publication, readiness exposes the lease-owned loaded release and `dist/current` release identities, and an older loaded release is blocked rather than accepted from stable launcher bytes.
