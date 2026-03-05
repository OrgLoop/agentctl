import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Byte-size threshold above which prompts are written to a temp file
 * and piped via stdin instead of passed as CLI arguments.
 *
 * macOS ARG_MAX is ~1MB but includes all args + environment, and some
 * tools/shells impose lower limits. 100KB is a safe threshold.
 */
export const LARGE_PROMPT_THRESHOLD = 100_000;

/** Check if a prompt exceeds the safe CLI argument size threshold. */
export function isLargePrompt(prompt: string): boolean {
  return Buffer.byteLength(prompt) > LARGE_PROMPT_THRESHOLD;
}

/**
 * Write a prompt to a temp file and return the path.
 * The file is placed in `$TMPDIR/agentctl/` with a unique name.
 */
export async function writePromptFile(prompt: string): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), "agentctl");
  await fs.mkdir(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, `prompt-${Date.now()}-${process.pid}.txt`);
  await fs.writeFile(filePath, prompt);
  return filePath;
}

/**
 * Open a prompt temp file as a read-only fd suitable for use as spawn stdio[0].
 * Returns the fd handle — caller must close it after spawn.
 */
export async function openPromptFd(
  promptFilePath: string,
): Promise<fs.FileHandle> {
  return fs.open(promptFilePath, "r");
}

/**
 * Clean up a prompt temp file. Safe to call immediately after spawn since
 * the child process inherits the fd directly (Unix: unlink removes the
 * directory entry but data persists until all fds are closed).
 */
export async function cleanupPromptFile(filePath: string): Promise<void> {
  await fs.unlink(filePath).catch(() => {});
}
