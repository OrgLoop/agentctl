import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 24-hour TTL for session metadata files */
const META_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Minimal metadata persisted by launch() so PID-based status checks survive
 * wrapper exit. Only stores PID + process start time — no cwd/model/prompt
 * (those belong in daemon state, not adapter shadow files).
 */
export interface LaunchedSessionMeta {
  sessionId: string;
  pid: number;
  /** Process start time from `ps -p <pid> -o lstart=` for PID recycling detection */
  startTime?: string;
  launchedAt: string; // ISO 8601 — used for TTL expiry
  /** Path to adapter launch log — used as fallback for peek on short-lived sessions */
  logPath?: string;
}

/**
 * Write minimal session metadata to disk.
 * Captures process start time via `ps` for PID recycling detection.
 */
export async function writeSessionMeta(
  metaDir: string,
  meta: { sessionId: string; pid: number },
): Promise<void> {
  await fs.mkdir(metaDir, { recursive: true });

  let startTime: string | undefined;
  try {
    const { stdout } = await execFileAsync("ps", [
      "-p",
      meta.pid.toString(),
      "-o",
      "lstart=",
    ]);
    startTime = stdout.trim() || undefined;
  } catch {
    // Process may have already exited or ps failed
  }

  const fullMeta: LaunchedSessionMeta = {
    sessionId: meta.sessionId,
    pid: meta.pid,
    startTime,
    launchedAt: new Date().toISOString(),
  };
  const metaPath = path.join(metaDir, `${meta.sessionId}.json`);
  await fs.writeFile(metaPath, JSON.stringify(fullMeta, null, 2));
}

/**
 * Read session metadata, returning null if not found or expired (24h TTL).
 */
export async function readSessionMeta(
  metaDir: string,
  sessionId: string,
): Promise<LaunchedSessionMeta | null> {
  // Exact match first
  const metaPath = path.join(metaDir, `${sessionId}.json`);
  try {
    const raw = await fs.readFile(metaPath, "utf-8");
    const meta = JSON.parse(raw) as LaunchedSessionMeta;
    if (isMetaExpired(meta)) {
      await fs.unlink(metaPath).catch(() => {});
      return null;
    }
    return meta;
  } catch {
    // File doesn't exist or is unreadable
  }

  // Scan for prefix match
  try {
    const files = await fs.readdir(metaDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const filePath = path.join(metaDir, file);
        const raw = await fs.readFile(filePath, "utf-8");
        const meta = JSON.parse(raw) as LaunchedSessionMeta;
        if (isMetaExpired(meta)) {
          await fs.unlink(filePath).catch(() => {});
          continue;
        }
        if (meta.sessionId === sessionId) return meta;
      } catch {
        // skip
      }
    }
  } catch {
    // Dir doesn't exist
  }
  return null;
}

/**
 * Delete session metadata file.
 */
export async function deleteSessionMeta(
  metaDir: string,
  sessionId: string,
): Promise<void> {
  const metaPath = path.join(metaDir, `${sessionId}.json`);
  await fs.unlink(metaPath).catch(() => {});
}

/**
 * Clean up all expired metadata files (24h TTL).
 * Safe to call periodically (e.g. during discover()).
 */
export async function cleanupExpiredMeta(metaDir: string): Promise<number> {
  let cleaned = 0;
  try {
    const files = await fs.readdir(metaDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const filePath = path.join(metaDir, file);
        const raw = await fs.readFile(filePath, "utf-8");
        const meta = JSON.parse(raw) as LaunchedSessionMeta;
        if (isMetaExpired(meta)) {
          await fs.unlink(filePath).catch(() => {});
          cleaned++;
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // Dir doesn't exist — nothing to clean
  }
  return cleaned;
}

function isMetaExpired(meta: LaunchedSessionMeta): boolean {
  if (!meta.launchedAt) return false;
  return Date.now() - new Date(meta.launchedAt).getTime() > META_TTL_MS;
}
