import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const ENV_FILE = "daemon-env.json";

/**
 * Common bin directories that should be in PATH when spawning subprocesses.
 * These cover the usual locations for various package managers and tools.
 */
function getCommonBinDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".local", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/opt/homebrew/bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, ".cargo", "bin"),
  ];
}

/**
 * Save the current process environment to disk.
 * Called at daemon start time when we still have the user's shell env.
 */
export async function saveEnvironment(configDir: string): Promise<void> {
  const envPath = path.join(configDir, ENV_FILE);
  try {
    const tmpPath = `${envPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(process.env));
    await fs.rename(tmpPath, envPath);
  } catch (err) {
    console.error(
      `Warning: could not save environment: ${(err as Error).message}`,
    );
  }
}

/**
 * Load the saved environment from disk.
 * Returns undefined if the env file doesn't exist or is corrupt.
 */
export async function loadSavedEnvironment(
  configDir: string,
): Promise<Record<string, string> | undefined> {
  const envPath = path.join(configDir, ENV_FILE);
  try {
    const raw = await fs.readFile(envPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, string>;
    }
  } catch {
    // File doesn't exist or is corrupt
  }
  return undefined;
}

/**
 * Build an augmented environment for spawning subprocesses.
 * Merges the saved daemon env with common bin paths to ensure
 * binaries are findable even when the daemon is detached from the shell.
 */
export function buildSpawnEnv(
  savedEnv?: Record<string, string>,
  extraEnv?: Record<string, string>,
): Record<string, string> {
  const base: Record<string, string> = {};
  const source = savedEnv || (process.env as Record<string, string>);

  // Copy source env
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined) base[k] = v;
  }

  // Augment PATH with common bin directories
  const existingPath = base.PATH || "";
  const existingDirs = new Set(existingPath.split(":").filter(Boolean));
  const commonDirs = getCommonBinDirs();
  const newDirs = commonDirs.filter((d) => !existingDirs.has(d));

  if (newDirs.length > 0) {
    base.PATH = [...existingPath.split(":").filter(Boolean), ...newDirs].join(
      ":",
    );
  }

  // Apply extra env overrides
  if (extraEnv) {
    for (const [k, v] of Object.entries(extraEnv)) {
      base[k] = v;
    }
  }

  return base;
}
