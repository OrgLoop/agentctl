import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Cache of resolved binary paths: name → absolute path */
const resolvedCache = new Map<string, string>();

/**
 * Resolve the absolute path to a binary, checking known locations first,
 * then falling back to `which`. Results are cached per binary name.
 *
 * @param name - Binary name (e.g., "claude", "codex", "pi")
 * @param knownLocations - Additional absolute paths to check first
 * @returns Resolved absolute path, or bare name as last resort
 */
export async function resolveBinaryPath(
  name: string,
  knownLocations: string[] = [],
): Promise<string> {
  const cached = resolvedCache.get(name);
  if (cached) return cached;

  const home = os.homedir();

  // Default well-known locations for common toolchains
  const defaultLocations = [
    path.join(home, ".local", "bin", name),
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`, // Homebrew Apple Silicon
    path.join(home, ".npm-global", "bin", name),
    path.join(home, ".local", "share", "mise", "shims", name),
    path.join(home, ".cargo", "bin", name),
  ];

  const candidates = [...knownLocations, ...defaultLocations];

  for (const c of candidates) {
    try {
      await fs.access(c, fs.constants.X_OK);
      // Resolve symlinks to get the actual binary path
      const resolved = await fs.realpath(c);
      await fs.access(resolved, fs.constants.X_OK);
      resolvedCache.set(name, resolved);
      return resolved;
    } catch {
      // Try next
    }
  }

  // Try `which <name>` as fallback
  try {
    const { stdout } = await execFileAsync("which", [name]);
    const p = stdout.trim();
    if (p) {
      resolvedCache.set(name, p);
      return p;
    }
  } catch {
    // Fall through
  }

  // Last resort: bare name (let PATH resolve it at spawn time)
  return name;
}

/**
 * Clear the resolved path cache. Call this when binaries may have been
 * updated (e.g., on daemon restart).
 */
export function clearBinaryCache(): void {
  resolvedCache.clear();
}
