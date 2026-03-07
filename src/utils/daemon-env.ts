import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Common bin directories that should be in PATH when spawning subprocesses.
 * These cover the usual locations for various package managers and tools.
 */
export function getCommonBinDirs(): string[] {
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
 * Source ~/.zshenv (or other shell init) and capture the resulting environment.
 * Returns undefined if the file doesn't exist or sourcing fails.
 */
function sourceZshEnv(): Record<string, string> | undefined {
  const zshenv = path.join(os.homedir(), ".zshenv");
  try {
    const output = execFileSync(
      "/bin/zsh",
      ["-c", `source "${zshenv}" 2>/dev/null; env -0`],
      {
        encoding: "utf-8",
        timeout: 5000,
        env: { HOME: os.homedir(), PATH: "/usr/bin:/bin" },
      },
    );
    const env: Record<string, string> = {};
    for (const entry of output.split("\0")) {
      if (!entry) continue;
      const idx = entry.indexOf("=");
      if (idx > 0) {
        env[entry.slice(0, idx)] = entry.slice(idx + 1);
      }
    }
    return Object.keys(env).length > 0 ? env : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build an augmented environment for spawning subprocesses.
 * Starts with process.env, overlays ~/.zshenv at call time when available,
 * then augments PATH with common bin directories.
 */
export function buildSpawnEnv(
  extraEnv?: Record<string, string>,
): Record<string, string> {
  const base: Record<string, string> = {};
  const zshEnv = sourceZshEnv();
  const source = {
    ...(process.env as Record<string, string | undefined>),
    ...(zshEnv ?? {}),
  };

  // Copy merged env
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
