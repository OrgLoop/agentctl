import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from "node:child_process";
import { clearBinaryCache, resolveBinaryPath } from "./resolve-binary.js";

/**
 * Spawn a binary with ENOENT retry.
 *
 * On ENOENT, waits 500ms, clears the binary path cache, re-resolves
 * the binary, and retries once. This handles transient cases where
 * binaries are being installed/updated during daemon operation.
 */
export async function spawnWithRetry(
  binaryName: string,
  args: string[],
  opts: SpawnOptions,
  knownLocations?: string[],
): Promise<ChildProcess> {
  const binaryPath = await resolveBinaryPath(binaryName, knownLocations);

  try {
    return await spawnAndCheck(binaryPath, args, opts);
  } catch (err) {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") throw err;

    // ENOENT: wait 500ms, clear cache, retry once
    await new Promise((r) => setTimeout(r, 500));
    clearBinaryCache();

    const retryPath = await resolveBinaryPath(binaryName, knownLocations);
    return spawnAndCheck(retryPath, args, opts);
  }
}

/**
 * Spawn a child and wait briefly for an error event.
 * If no error fires within a microtask cycle, resolve with the child.
 * If ENOENT fires, reject so the caller can retry.
 */
function spawnAndCheck(
  binaryPath: string,
  args: string[],
  opts: SpawnOptions,
): Promise<ChildProcess> {
  const child = spawn(binaryPath, args, opts);

  return new Promise<ChildProcess>((resolve, reject) => {
    let settled = false;

    const onError = (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      child.removeListener("error", onError);
      if (err.code === "ENOENT") {
        reject(err);
      } else {
        // Non-ENOENT: resolve with the child (caller may still get error events)
        resolve(child);
      }
    };

    child.on("error", onError);

    // Spawn errors (ENOENT) fire synchronously on the next tick.
    // Give one event-loop cycle for the error to arrive, then resolve.
    setImmediate(() => {
      if (!settled) {
        settled = true;
        child.removeListener("error", onError);
        resolve(child);
      }
    });
  });
}
