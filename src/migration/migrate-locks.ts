import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Lock } from "../daemon/state.js";

/**
 * One-time migration from ~/.openclaw/locks/locks.json to ~/.agentctl/locks.json.
 * Idempotent — skips if target already exists or source is missing.
 */
export async function migrateLocks(configDir?: string): Promise<number> {
  const targetDir = configDir || path.join(os.homedir(), ".agentctl");
  const oldPath = path.join(os.homedir(), ".openclaw", "locks", "locks.json");
  const newPath = path.join(targetDir, "locks.json");

  // Skip if already migrated
  if (await fileExists(newPath)) return 0;
  // Skip if no old file
  if (!(await fileExists(oldPath))) return 0;

  const oldData = JSON.parse(await fs.readFile(oldPath, "utf-8"));

  // Transform old format → new format
  // Old format: array of { directory, lockedBy, reason, lockedAt }
  const newLocks: Lock[] = (Array.isArray(oldData) ? oldData : []).map(
    (old: Record<string, unknown>) => ({
      directory: old.directory as string,
      type: "manual" as const,
      lockedBy: (old.lockedBy || old.by || "unknown") as string,
      reason: (old.reason || "") as string,
      lockedAt: (old.lockedAt as string) || new Date().toISOString(),
    }),
  );

  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(newPath, JSON.stringify(newLocks, null, 2));

  console.log(`Migrated ${newLocks.length} locks from ${oldPath}`);
  return newLocks.length;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
