import type { AgentAdapter, AgentSession } from "../core/types.js";
import type { SessionRecord, StateManager } from "./state.js";

export interface SessionTrackerOpts {
  adapters: Record<string, AgentAdapter>;
  pollIntervalMs?: number;
  /** Override PID liveness check for testing (default: process.kill(pid, 0)) */
  isProcessAlive?: (pid: number) => boolean;
}

/** Max age for stopped sessions in state before pruning (7 days) */
const STOPPED_SESSION_PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class SessionTracker {
  private state: StateManager;
  private adapters: Record<string, AgentAdapter>;
  private pollIntervalMs: number;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(state: StateManager, opts: SessionTrackerOpts) {
    this.state = state;
    this.adapters = opts.adapters;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  }

  startPolling(): void {
    if (this.pollHandle) return;
    // Prune old stopped sessions on startup
    this.pruneOldSessions();
    // Initial poll
    this.guardedPoll();
    this.pollHandle = setInterval(() => {
      this.guardedPoll();
    }, this.pollIntervalMs);
  }

  /** Run poll() with a guard to skip if the previous cycle is still running */
  private guardedPoll(): void {
    if (this.polling) return;
    this.polling = true;
    this.poll()
      .catch((err) => console.error("Poll error:", err))
      .finally(() => {
        this.polling = false;
      });
  }

  stopPolling(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private async poll(): Promise<void> {
    // Collect PIDs from all adapter-returned sessions (the source of truth)
    const adapterPidToId = new Map<number, string>();

    for (const [adapterName, adapter] of Object.entries(this.adapters)) {
      try {
        const sessions = await adapter.list({ all: true });
        for (const session of sessions) {
          if (session.pid) {
            adapterPidToId.set(session.pid, session.id);
          }

          const existing = this.state.getSession(session.id);
          const record = sessionToRecord(session, adapterName);

          if (!existing) {
            this.state.setSession(session.id, record);
          } else if (
            existing.status !== record.status ||
            (!existing.model && record.model)
          ) {
            // Status changed or model resolved — update
            this.state.setSession(session.id, {
              ...existing,
              status: record.status,
              stoppedAt: record.stoppedAt,
              model: record.model || existing.model,
              tokens: record.tokens,
              cost: record.cost,
              prompt: record.prompt || existing.prompt,
            });
          }
        }
      } catch {
        // Adapter unavailable — skip
      }
    }

    // Reap stale entries from daemon state
    this.reapStaleEntries(adapterPidToId);
  }

  /**
   * Clean up ghost sessions in the daemon state:
   * - pending-* entries whose PID matches a resolved session → remove pending
   * - Any "running"/"idle" session in state whose PID is dead → mark stopped
   */
  private reapStaleEntries(adapterPidToId: Map<number, string>): void {
    const sessions = this.state.getSessions();

    for (const [id, record] of Object.entries(sessions)) {
      // Bug 2: If this is a pending-* entry and a real session has the same PID,
      // the pending entry is stale — remove it
      if (id.startsWith("pending-") && record.pid) {
        const resolvedId = adapterPidToId.get(record.pid);
        if (resolvedId && resolvedId !== id) {
          this.state.removeSession(id);
          continue;
        }
      }

      // Bug 1: If session is "running"/"idle" but PID is dead, mark stopped
      if (
        (record.status === "running" || record.status === "idle") &&
        record.pid
      ) {
        // Only reap if the adapter didn't return this session as running
        // (adapter is the source of truth for sessions it knows about)
        const adapterId = adapterPidToId.get(record.pid);
        if (adapterId === id) continue; // Adapter confirmed this PID is active

        if (!this.isProcessAlive(record.pid)) {
          this.state.setSession(id, {
            ...record,
            status: "stopped",
            stoppedAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  /**
   * Remove stopped sessions from state that have been stopped for more than 7 days.
   * This reduces overhead from accumulating hundreds of historical sessions.
   */
  private pruneOldSessions(): void {
    const sessions = this.state.getSessions();
    const now = Date.now();
    let pruned = 0;

    for (const [id, record] of Object.entries(sessions)) {
      if (
        record.status !== "stopped" &&
        record.status !== "completed" &&
        record.status !== "failed"
      ) {
        continue;
      }
      const stoppedAt = record.stoppedAt
        ? new Date(record.stoppedAt).getTime()
        : new Date(record.startedAt).getTime();
      if (now - stoppedAt > STOPPED_SESSION_PRUNE_AGE_MS) {
        this.state.removeSession(id);
        pruned++;
      }
    }

    if (pruned > 0) {
      console.error(`Pruned ${pruned} sessions stopped >7 days ago from state`);
    }
  }

  /** Track a newly launched session */
  track(session: AgentSession, adapterName: string): SessionRecord {
    const record = sessionToRecord(session, adapterName);

    // Pending→UUID reconciliation: if this is a real session (not pending),
    // remove any pending-PID placeholder with the same PID
    if (!session.id.startsWith("pending-") && session.pid) {
      for (const [id, existing] of Object.entries(this.state.getSessions())) {
        if (id.startsWith("pending-") && existing.pid === session.pid) {
          this.state.removeSession(id);
        }
      }
    }

    this.state.setSession(session.id, record);
    return record;
  }

  /** Get session record by id (exact or prefix) */
  getSession(id: string): SessionRecord | undefined {
    // Exact match
    const exact = this.state.getSession(id);
    if (exact) return exact;

    // Prefix match
    const sessions = this.state.getSessions();
    const matches = Object.entries(sessions).filter(([key]) =>
      key.startsWith(id),
    );
    if (matches.length === 1) return matches[0][1];
    return undefined;
  }

  /** List all tracked sessions */
  listSessions(opts?: {
    status?: string;
    all?: boolean;
    adapter?: string;
  }): SessionRecord[] {
    const sessions = Object.values(this.state.getSessions());

    // Liveness check: mark sessions with dead PIDs as stopped
    for (const s of sessions) {
      if ((s.status === "running" || s.status === "idle") && s.pid) {
        if (!this.isProcessAlive(s.pid)) {
          s.status = "stopped";
          s.stoppedAt = new Date().toISOString();
          this.state.setSession(s.id, s);
        }
      }
    }

    let filtered = sessions;

    if (opts?.adapter) {
      filtered = filtered.filter((s) => s.adapter === opts.adapter);
    }

    if (opts?.status) {
      filtered = filtered.filter((s) => s.status === opts.status);
    } else if (!opts?.all) {
      filtered = filtered.filter(
        (s) => s.status === "running" || s.status === "idle",
      );
    }

    // Dedup: if a pending-* entry shares a PID with a resolved entry, show only the resolved one
    filtered = deduplicatePendingSessions(filtered);

    return filtered.sort((a, b) => {
      // Running first, then by recency
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;
      return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
    });
  }

  activeCount(): number {
    return Object.values(this.state.getSessions()).filter(
      (s) => s.status === "running" || s.status === "idle",
    ).length;
  }

  /** Remove a session from state entirely (used for ghost cleanup) */
  removeSession(sessionId: string): void {
    this.state.removeSession(sessionId);
  }

  /** Called when a session stops — returns the cwd for fuse/lock processing */
  onSessionExit(sessionId: string): SessionRecord | undefined {
    const session = this.state.getSession(sessionId);
    if (session) {
      session.status = "stopped";
      session.stoppedAt = new Date().toISOString();
      this.state.setSession(sessionId, session);
    }
    return session;
  }
}

/** Check if a process is alive via kill(pid, 0) signal check */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove pending-* entries that share a PID with a resolved (non-pending) session.
 * This is a safety net for list output — the poll() reaper handles cleanup in state.
 */
function deduplicatePendingSessions(
  sessions: SessionRecord[],
): SessionRecord[] {
  const realPids = new Set<number>();
  for (const s of sessions) {
    if (!s.id.startsWith("pending-") && s.pid) {
      realPids.add(s.pid);
    }
  }
  return sessions.filter((s) => {
    if (s.id.startsWith("pending-") && s.pid && realPids.has(s.pid)) {
      return false;
    }
    return true;
  });
}

function sessionToRecord(
  session: AgentSession,
  adapterName: string,
): SessionRecord {
  return {
    id: session.id,
    adapter: adapterName,
    status: session.status,
    startedAt: session.startedAt.toISOString(),
    stoppedAt: session.stoppedAt?.toISOString(),
    cwd: session.cwd,
    spec: session.spec,
    model: session.model,
    prompt: session.prompt,
    tokens: session.tokens,
    cost: session.cost,
    pid: session.pid,
    meta: session.meta,
  };
}
