import { exec } from "node:child_process";
import type { EventEmitter } from "node:events";
import { promisify } from "node:util";
import type { FuseTimer, StateManager } from "./state.js";

const execAsync = promisify(exec);

export interface FuseEngineOpts {
  defaultDurationMs: number;
  emitter?: EventEmitter;
}

export interface SetFuseOpts {
  directory: string;
  sessionId: string;
  ttlMs?: number;
  onExpire?: FuseTimer["onExpire"];
  label?: string;
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

  /** Set a fuse for a directory. Called when a session exits or explicitly via API. */
  setFuse(opts: SetFuseOpts): void {
    const ttlMs = opts.ttlMs ?? this.defaultDurationMs;

    // Cancel existing fuse for same directory
    this.cancelFuse(opts.directory, false);

    const expiresAt = new Date(Date.now() + ttlMs);
    const fuse: FuseTimer = {
      directory: opts.directory,
      ttlMs,
      expiresAt: expiresAt.toISOString(),
      sessionId: opts.sessionId,
      onExpire: opts.onExpire,
      label: opts.label,
    };

    this.state.addFuse(fuse);

    const timeout = setTimeout(() => this.fireFuse(fuse), ttlMs);
    this.timers.set(opts.directory, timeout);

    this.emitter?.emit("fuse.set", fuse);
  }

  /** Extend an existing fuse's TTL. Resets the timer to a new duration. */
  extendFuse(directory: string, ttlMs?: number): boolean {
    const existing = this.state
      .getFuses()
      .find((f) => f.directory === directory);
    if (!existing) return false;

    const duration = ttlMs ?? existing.ttlMs;
    this.cancelFuse(directory, false);

    const expiresAt = new Date(Date.now() + duration);
    const fuse: FuseTimer = {
      ...existing,
      ttlMs: duration,
      expiresAt: expiresAt.toISOString(),
    };

    this.state.addFuse(fuse);

    const timeout = setTimeout(() => this.fireFuse(fuse), duration);
    this.timers.set(directory, timeout);

    this.emitter?.emit("fuse.extended", fuse);
    return true;
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

  /** Fire a fuse — execute the configured on-expire action. */
  private async fireFuse(fuse: FuseTimer): Promise<void> {
    this.timers.delete(fuse.directory);
    this.state.removeFuse(fuse.directory);

    const label = fuse.label || fuse.directory;
    console.log(`Fuse expired: ${label}`);

    this.emitter?.emit("fuse.expired", fuse);

    const action = fuse.onExpire;
    if (!action) return;

    // Execute on-expire script
    if (action.script) {
      try {
        await execAsync(action.script, {
          cwd: fuse.directory,
          timeout: 120_000,
        });
        console.log(`Fuse action completed: ${label}`);
      } catch (err) {
        console.error(`Fuse action failed for ${label}:`, err);
      }
    }

    // POST to webhook
    if (action.webhook) {
      try {
        const body = JSON.stringify({
          type: "fuse.expired",
          directory: fuse.directory,
          sessionId: fuse.sessionId,
          label: fuse.label,
          expiredAt: new Date().toISOString(),
        });
        await fetch(action.webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        console.error(`Fuse webhook failed for ${label}:`, err);
      }
    }

    // Emit named event
    if (action.event) {
      this.emitter?.emit(action.event, fuse);
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
