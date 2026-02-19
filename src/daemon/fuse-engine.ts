import { exec } from "node:child_process";
import type { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FuseTimer, SessionRecord, StateManager } from "./state.js";

const execAsync = promisify(exec);

export interface FuseEngineOpts {
  defaultDurationMs: number;
  emitter?: EventEmitter;
}

export class FuseEngine {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private state: StateManager;
  private defaultDurationMs: number;
  private emitter?: EventEmitter;

  constructor(state: StateManager, opts: FuseEngineOpts) {
    this.state = state;
    this.defaultDurationMs = opts.defaultDurationMs;
    this.emitter = opts.emitter;
  }

  /** Derive cluster name from worktree directory. Returns null if not a mono worktree. */
  static deriveClusterName(
    directory: string,
  ): { clusterName: string; branch: string } | null {
    const home = os.homedir();
    const monoPrefix = path.join(home, "code", "mono-");
    if (!directory.startsWith(monoPrefix)) return null;

    const branch = directory.slice(monoPrefix.length);
    if (!branch) return null;

    return {
      clusterName: `kindo-charlie-${branch}`,
      branch,
    };
  }

  /** Called when a session exits. Starts fuse if applicable. */
  onSessionExit(session: SessionRecord): void {
    if (!session.cwd) return;
    const derived = FuseEngine.deriveClusterName(session.cwd);
    if (!derived) return;

    this.startFuse(
      session.cwd,
      derived.clusterName,
      derived.branch,
      session.id,
    );
  }

  private startFuse(
    directory: string,
    clusterName: string,
    branch: string,
    sessionId: string,
  ): void {
    // Cancel existing fuse for same directory
    this.cancelFuse(directory, false);

    const expiresAt = new Date(Date.now() + this.defaultDurationMs);
    const fuse: FuseTimer = {
      directory,
      clusterName,
      branch,
      expiresAt: expiresAt.toISOString(),
      sessionId,
    };

    this.state.addFuse(fuse);

    const timeout = setTimeout(
      () => this.fireFuse(fuse),
      this.defaultDurationMs,
    );
    this.timers.set(directory, timeout);
  }

  /** Cancel fuse for a directory. */
  cancelFuse(directory: string, persist = true): boolean {
    const timer = this.timers.get(directory);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(directory);
    }
    if (persist) {
      this.state.removeFuse(directory);
    }
    return !!timer;
  }

  /** Resume fuses from persisted state after daemon restart. */
  resumeTimers(): void {
    const fuses = this.state.getFuses();
    const now = Date.now();
    for (const fuse of fuses) {
      const remaining = new Date(fuse.expiresAt).getTime() - now;
      if (remaining <= 0) {
        // Expired while daemon was down — fire immediately
        this.fireFuse(fuse);
      } else {
        const timeout = setTimeout(() => this.fireFuse(fuse), remaining);
        this.timers.set(fuse.directory, timeout);
      }
    }
  }

  /** Fire a fuse — delete the Kind cluster. */
  private async fireFuse(fuse: FuseTimer): Promise<void> {
    this.timers.delete(fuse.directory);
    this.state.removeFuse(fuse.directory);

    console.log(`Fuse fired: deleting cluster ${fuse.clusterName}`);

    try {
      // Best effort: yarn local:down first
      try {
        await execAsync("yarn local:down", {
          cwd: fuse.directory,
          timeout: 60_000,
        });
      } catch {
        // Ignore
      }

      await execAsync(`kind delete cluster --name ${fuse.clusterName}`, {
        timeout: 120_000,
      });
      console.log(`Cluster ${fuse.clusterName} deleted`);

      this.emitter?.emit("fuse.fired", fuse);
    } catch (err) {
      console.error(`Failed to delete cluster ${fuse.clusterName}:`, err);
    }
  }

  listActive(): FuseTimer[] {
    return this.state.getFuses();
  }

  /** Clear all timers (for clean shutdown) */
  shutdown(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
