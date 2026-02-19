import path from "node:path";
import type { Lock, StateManager } from "./state.js";

export class LockManager {
  constructor(private state: StateManager) {}

  /** Check if directory is locked. Returns the lock if so, null if free. */
  check(directory: string): Lock | null {
    const resolved = path.resolve(directory);
    const locks = this.state.getLocks();
    // Manual locks take precedence
    const manual = locks.find(
      (l) => l.directory === resolved && l.type === "manual",
    );
    if (manual) return manual;
    const auto = locks.find(
      (l) => l.directory === resolved && l.type === "auto",
    );
    return auto || null;
  }

  /** Auto-lock a directory for a session. Idempotent if same session. */
  autoLock(directory: string, sessionId: string): Lock {
    const resolved = path.resolve(directory);
    const existing = this.state
      .getLocks()
      .find(
        (l) =>
          l.directory === resolved &&
          l.type === "auto" &&
          l.sessionId === sessionId,
      );
    if (existing) return existing;

    const lock: Lock = {
      directory: resolved,
      type: "auto",
      sessionId,
      lockedAt: new Date().toISOString(),
    };
    this.state.addLock(lock);
    return lock;
  }

  /** Remove auto-lock for a session. */
  autoUnlock(sessionId: string): void {
    this.state.removeLocks(
      (l) => l.type === "auto" && l.sessionId === sessionId,
    );
  }

  /** Manual lock. Fails if already manually locked. */
  manualLock(directory: string, by?: string, reason?: string): Lock {
    const resolved = path.resolve(directory);
    const existing = this.check(resolved);
    if (existing?.type === "manual") {
      throw new Error(
        `Already manually locked by ${existing.lockedBy}: ${existing.reason}`,
      );
    }
    const lock: Lock = {
      directory: resolved,
      type: "manual",
      lockedBy: by,
      reason,
      lockedAt: new Date().toISOString(),
    };
    this.state.addLock(lock);
    return lock;
  }

  /** Manual unlock. Only removes manual locks. */
  manualUnlock(directory: string): void {
    const resolved = path.resolve(directory);
    const existing = this.state
      .getLocks()
      .find((l) => l.directory === resolved && l.type === "manual");
    if (!existing) throw new Error(`No manual lock on ${resolved}`);
    this.state.removeLocks(
      (l) => l.directory === resolved && l.type === "manual",
    );
  }

  listAll(): Lock[] {
    return this.state.getLocks();
  }
}
