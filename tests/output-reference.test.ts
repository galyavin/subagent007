import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  MAX_TERMINAL_OUTPUT_BYTES,
  createStreamingRunTranscript,
  decodeRunOutputReference,
  recoverStreamingRunTranscript,
  runOutputPath,
  writeRunOutput,
} from "../src/output.js";

async function fixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent007-output-reference-"));
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function runPlatformCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, (error) => error ? reject(error) : resolve());
  });
}

async function withRenameHook<T>(
  hook: (oldPath: string, newPath: string, rename: () => Promise<void>) => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  const originalRename = fs.rename;
  const mutableFs = fs as unknown as {
    rename: (...args: Parameters<typeof fs.rename>) => ReturnType<typeof fs.rename>;
  };
  let intercepted = false;
  mutableFs.rename = async (...args) => {
    if (intercepted) return originalRename(...args);
    intercepted = true;
    await hook(String(args[0]), String(args[1]), () => originalRename(...args));
  };
  try {
    return await run();
  } finally {
    mutableFs.rename = originalRename;
  }
}

async function withShortReadHook<T>(
  targetPath: string,
  onShortRead: () => void,
  run: () => Promise<T>,
): Promise<T> {
  const originalOpen = fs.open;
  const mutableFs = fs as unknown as {
    open: (...args: Parameters<typeof fs.open>) => ReturnType<typeof fs.open>;
  };
  mutableFs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) !== targetPath) return handle;
    const mutableHandle = handle as unknown as {
      read: (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null,
      ) => Promise<{ bytesRead: number; buffer: Buffer }>;
    };
    const originalRead = mutableHandle.read;
    let shortened = false;
    mutableHandle.read = async (buffer, offset, length, position) => {
      if (shortened || length <= 0) return originalRead.call(handle, buffer, offset, length, position);
      shortened = true;
      onShortRead();
      return originalRead.call(handle, buffer, offset, length - 1, position);
    };
    return handle;
  };
  try {
    return await run();
  } finally {
    mutableFs.open = originalOpen;
  }
}

function reference(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "file",
    name: "primary",
    relative_path: "2026-07-24T213913724Z-d81a1c1dc733.md",
    size_bytes: 5,
    content_sha256: "a".repeat(64),
    content_type: "text/markdown",
    encoding: "utf-8",
    output_mode: "final",
    ...overrides,
  };
}

test("terminal output emits one exact canonical relative digest reference", async () => {
  const f = await fixture();
  try {
    const output = await writeRunOutput("exact final bytes", f.root);
    const outputPath = runOutputPath(output.reference, f.root);
    assert.equal(Object.hasOwn(output, "outputPath"), false);
    assert.deepEqual(output.reference, {
      kind: "file",
      name: "primary",
      relative_path: path.basename(outputPath),
      size_bytes: Buffer.byteLength("exact final bytes"),
      content_sha256: createHash("sha256").update("exact final bytes").digest("hex"),
      content_type: "text/markdown",
      encoding: "utf-8",
      output_mode: "final",
    });
    assert.equal(await fs.readFile(outputPath, "utf8"), "exact final bytes");
  } finally {
    await f.cleanup();
  }
});

test("rename-window rewrite emits the post-rename digest and bytes", async () => {
  const f = await fixture();
  try {
    const streaming = await createStreamingRunTranscript(f.root, { ownerId: "rename-window-run" });
    await streaming.appendProcessLine("AAAA");
    const metadataReference = path.join(f.root, "rename-window-metadata-reference");
    await runPlatformCommand("cp", ["-p", streaming.stagingPath, metadataReference]);

    const output = await withRenameHook(
      async (oldPath, _newPath, rename) => {
        if (oldPath !== streaming.stagingPath) return;
        const rewrite = await fs.open(streaming.stagingPath, "r+");
        try {
          await rewrite.write(Buffer.from("BBBB"), 0, 4, 0);
          await rewrite.sync();
        } finally {
          await rewrite.close();
        }
        await runPlatformCommand("touch", ["-r", metadataReference, streaming.stagingPath]);
        await rename();
      },
      () => streaming.finalize(),
    );

    assert.equal(output.reference.size_bytes, 4);
    assert.equal(output.reference.content_sha256, createHash("sha256").update("BBBB").digest("hex"));
    assert.equal(await fs.readFile(runOutputPath(output.reference, f.root), "utf8"), "BBBB");
  } finally {
    await f.cleanup();
  }
});

test("streaming finalization rejects same-inode same-size content rewrite with restored mtime", async () => {
  const f = await fixture();
  try {
    const streaming = await createStreamingRunTranscript(f.root, { ownerId: "ctime-run" });
    await streaming.appendProcessLine("AAAA");
    const metadataReference = path.join(f.root, "exact-metadata-reference");
    await runPlatformCommand("cp", ["-p", streaming.stagingPath, metadataReference]);

    await assert.rejects(
      streaming.finalize({
        beforeRename: async () => {
          const rewrite = await fs.open(streaming.stagingPath, "r+");
          try {
            await rewrite.write(Buffer.from("BBBB"), 0, 4, 0);
            await rewrite.sync();
          } finally {
            await rewrite.close();
          }
          await runPlatformCommand("touch", ["-r", metadataReference, streaming.stagingPath]);
        },
      }),
      /changed during descriptor finalization/,
    );
  } finally {
    await f.cleanup();
  }
});

test("restart recovery rejects same-inode same-size content rewrite with restored mtime", async () => {
  const f = await fixture();
  try {
    const runId = "ctime-recovery";
    const stagingPath = path.join(
      f.root,
      `.${runId}.2026-07-24T213913724Z-c71e00000000.partial`,
    );
    await fs.writeFile(stagingPath, "AAAA");
    const metadataReference = path.join(f.root, "recovery-exact-metadata-reference");
    await runPlatformCommand("cp", ["-p", stagingPath, metadataReference]);

    await assert.rejects(
      recoverStreamingRunTranscript(stagingPath, runId, {
        beforeRename: async () => {
          const rewrite = await fs.open(stagingPath, "r+");
          try {
            await rewrite.write(Buffer.from("BBBB"), 0, 4, 0);
            await rewrite.sync();
          } finally {
            await rewrite.close();
          }
          await runPlatformCommand("touch", ["-r", metadataReference, stagingPath]);
        },
      }),
      /changed during descriptor finalization/,
    );
  } finally {
    await f.cleanup();
  }
});

test("post-rename descriptor mutation during hashing rejects without a reference", async () => {
  const f = await fixture();
  try {
    const streaming = await createStreamingRunTranscript(f.root, { ownerId: "post-read-mutation" });
    await streaming.appendProcessLine("AAAA");
    const outputPath = path.join(
      f.root,
      path.basename(streaming.stagingPath).replace(/^\.post-read-mutation\./, "").replace(/\.partial$/, ".md"),
    );
    await assert.rejects(
      streaming.finalize({
        afterDescriptorRead: async () => {
          const rewrite = await fs.open(outputPath, "r+");
          try {
            await rewrite.write(Buffer.from("BBBB"), 0, 4, 0);
            await rewrite.sync();
          } finally {
            await rewrite.close();
          }
        },
      }),
      /changed during descriptor finalization/,
    );
  } finally {
    await f.cleanup();
  }
});

test("already-published recovery applies the same post-read final-path witness", async () => {
  const f = await fixture();
  try {
    const runId = "published-recovery";
    const streaming = await createStreamingRunTranscript(f.root, { ownerId: runId });
    await streaming.appendProcessLine("AAAA");
    const published = await streaming.finalize();
    const publishedPath = runOutputPath(published.reference, f.root);
    await assert.rejects(
      recoverStreamingRunTranscript(streaming.stagingPath, runId, {
        afterDescriptorRead: async () => {
          const rewrite = await fs.open(publishedPath, "r+");
          try {
            await rewrite.write(Buffer.from("BBBB"), 0, 4, 0);
            await rewrite.sync();
          } finally {
            await rewrite.close();
          }
        },
      }),
      /changed during descriptor finalization/,
    );
  } finally {
    await f.cleanup();
  }
});

test("final pathname replacement rejects before reference emission", async () => {
  const f = await fixture();
  try {
    const streaming = await createStreamingRunTranscript(f.root, { ownerId: "pathname-mismatch" });
    await streaming.appendProcessLine("AAAA");
    await assert.rejects(
      withRenameHook(
        async (_oldPath, newPath, rename) => {
          await rename();
          await fs.rename(newPath, `${newPath}.displaced`);
          await fs.writeFile(newPath, "BBBB");
        },
        () => streaming.finalize(),
      ),
      /changed during descriptor finalization/,
    );
  } finally {
    await f.cleanup();
  }
});

test("post-rename growth beyond the bounded inspection limit rejects", async () => {
  const f = await fixture();
  try {
    const streaming = await createStreamingRunTranscript(f.root, { ownerId: "post-rename-growth" });
    await streaming.appendProcessLine("AAAA");
    await assert.rejects(
      withRenameHook(
        async (_oldPath, newPath, rename) => {
          await rename();
          await fs.appendFile(newPath, Buffer.alloc(MAX_TERMINAL_OUTPUT_BYTES, 0x78));
        },
        () => streaming.finalize(),
      ),
      /(1 MiB terminal-output limit|changed during descriptor finalization)/,
    );
  } finally {
    await f.cleanup();
  }
});

test("short descriptor reads reject before emitting a reference", async () => {
  const f = await fixture();
  try {
    const runId = "short-read-recovery";
    const stagingPath = path.join(
      f.root,
      `.${runId}.2026-07-24T213913724Z-c71e00000000.partial`,
    );
    await fs.writeFile(stagingPath, "AAAA");
    let shortReadInjected = false;
    await assert.rejects(
      withShortReadHook(
        stagingPath,
        () => { shortReadInjected = true; },
        () => recoverStreamingRunTranscript(stagingPath, runId),
      ),
      /changed during descriptor finalization/,
    );
    assert.equal(shortReadInjected, true);
  } finally {
    await f.cleanup();
  }
});

test("ordinary rename succeeds despite its ctime transition", async () => {
  const f = await fixture();
  try {
    const streaming = await createStreamingRunTranscript(f.root, { ownerId: "ordinary-rename" });
    await streaming.appendProcessLine("ordinary bytes");
    const output = await streaming.finalize();
    assert.equal(output.reference.content_sha256, createHash("sha256").update("ordinary bytes").digest("hex"));
    assert.equal(await fs.readFile(runOutputPath(output.reference, f.root), "utf8"), "ordinary bytes");
  } finally {
    await f.cleanup();
  }
});

test("exact output-reference decoder rejects path-only, noncanonical locator, size, digest, and cardinality shapes", () => {
  assert.deepEqual(decodeRunOutputReference(reference()), reference());
  for (const invalid of [
    { kind: "file", name: "primary", path: "/tmp/old.md", size_bytes: 5, content_type: "text/markdown", encoding: "utf-8", output_mode: "final" },
    reference({ relative_path: "/tmp/absolute.md" }),
    reference({ relative_path: "nested/output.md" }),
    reference({ relative_path: "../output.md" }),
    reference({ relative_path: "." }),
    reference({ relative_path: "é.md" }),
    reference({ relative_path: "not-a-provider-name.md" }),
    reference({ size_bytes: -1 }),
    reference({ size_bytes: MAX_TERMINAL_OUTPUT_BYTES + 1 }),
    reference({ size_bytes: 1.5 }),
    reference({ content_sha256: "A".repeat(64) }),
    reference({ content_sha256: "a".repeat(63) }),
    reference({ content_sha256: undefined }),
    reference({ path: "/tmp/leak.md" }),
  ]) {
    assert.equal(decodeRunOutputReference(invalid), undefined, JSON.stringify(invalid));
  }
});

test("normal and recovery output reject 1 MiB plus one byte", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      writeRunOutput("x".repeat(MAX_TERMINAL_OUTPUT_BYTES + 1), f.root),
      /1 MiB terminal-output limit/,
    );
    const streaming = await createStreamingRunTranscript(f.root, { ownerId: "cap-run" });
    await assert.rejects(
      streaming.appendProcessLine("x".repeat(MAX_TERMINAL_OUTPUT_BYTES + 1)),
      /1 MiB terminal-output limit/,
    );
    await streaming.discard();

    const runId = "recovery-cap";
    const basename = `.${runId}.2026-07-24T213913724Z-d81a1c1dc733.partial`;
    const stagingPath = path.join(f.root, basename);
    await fs.writeFile(stagingPath, Buffer.alloc(MAX_TERMINAL_OUTPUT_BYTES + 1, 0x78));
    await assert.rejects(recoverStreamingRunTranscript(stagingPath, runId), /1 MiB terminal-output limit/);
  } finally {
    await f.cleanup();
  }
});

test("streaming finalization rejects hardlinks and pathname replacement before rename", async () => {
  const f = await fixture();
  try {
    const linked = await createStreamingRunTranscript(f.root, { ownerId: "linked-run" });
    await linked.appendProcessLine("linked bytes");
    await fs.link(linked.stagingPath, path.join(f.root, "second-link"));
    await assert.rejects(linked.finalize(), /single-link regular file/);

    const replaced = await createStreamingRunTranscript(f.root, { ownerId: "replaced-run" });
    await replaced.appendProcessLine("original bytes");
    await assert.rejects(
      replaced.finalize({
        beforeRename: async () => {
          await fs.rename(replaced.stagingPath, `${replaced.stagingPath}.displaced`);
          await fs.writeFile(replaced.stagingPath, "replacement bytes");
        },
      }),
      /changed during descriptor finalization/,
    );
  } finally {
    await f.cleanup();
  }
});

test("restart recovery rejects symlink, directory, hardlink, and replacement", async () => {
  const f = await fixture();
  try {
    const runId = "recovery-special";
    const makePath = (suffix: string) => path.join(
      f.root,
      `.${runId}.2026-07-24T213913724Z-${suffix}.partial`,
    );

    const target = path.join(f.root, "target");
    await fs.writeFile(target, "target");
    const symlink = makePath("111111111111");
    await fs.symlink(target, symlink);
    await assert.rejects(recoverStreamingRunTranscript(symlink, runId), /no-follow single-link regular file/);

    const directory = makePath("222222222222");
    await fs.mkdir(directory);
    await assert.rejects(recoverStreamingRunTranscript(directory, runId), /no-follow single-link regular file/);

    const fifo = makePath("333333333333");
    await runPlatformCommand("mkfifo", [fifo]);
    await assert.rejects(recoverStreamingRunTranscript(fifo, runId), /no-follow single-link regular file/);

    const hardlink = makePath("444444444444");
    await fs.writeFile(hardlink, "linked");
    await fs.link(hardlink, path.join(f.root, "recovery-second-link"));
    await assert.rejects(recoverStreamingRunTranscript(hardlink, runId), /single-link regular file/);

    const replaced = makePath("555555555555");
    await fs.writeFile(replaced, "original");
    await assert.rejects(
      recoverStreamingRunTranscript(replaced, runId, {
        beforeRename: async () => {
          await fs.rename(replaced, `${replaced}.displaced`);
          await fs.writeFile(replaced, "replacement");
        },
      }),
      /changed during descriptor finalization/,
    );
  } finally {
    await f.cleanup();
  }
});
