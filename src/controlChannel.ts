const CONTROL_LOSS_FORCE_MS = 1_000;

export function terminateOwnedProcessGroupOnControlLoss(): void {
  if (process.platform === "win32") {
    process.kill(process.pid, "SIGTERM");
    return;
  }
  const absorbGracefulSignal = () => {
    // Keep the group leader alive long enough to force-kill descendants that ignore SIGTERM.
  };
  process.once("SIGTERM", absorbGracefulSignal);
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch {
    process.removeListener("SIGTERM", absorbGracefulSignal);
    process.kill(process.pid, "SIGTERM");
    return;
  }
  setTimeout(() => {
    process.kill(-process.pid, "SIGKILL");
  }, CONTROL_LOSS_FORCE_MS);
}
