import type { AgentAdapter, AgentSession } from "../core/types.js";
import type { SessionRecord, StateManager } from "./state.js";

export interface SessionTrackerOpts {
  adapters: Record<string, AgentAdapter>;
  pollIntervalMs?: number;
}

export class SessionTracker {
  private state: StateManager;
  private adapters: Record<string, AgentAdapter>;
  private pollIntervalMs: number;
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  constructor(state: StateManager, opts: SessionTrackerOpts) {
    this.state = state;
    this.adapters = opts.adapters;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
  }

  startPolling(): void {
    if (this.pollHandle) return;
    // Initial poll
    this.poll().catch((err) => console.error("Poll error:", err));
    this.pollHandle = setInterval(() => {
      this.poll().catch((err) => console.error("Poll error:", err));
    }, this.pollIntervalMs);
  }

  stopPolling(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private async poll(): Promise<void> {
    for (const [adapterName, adapter] of Object.entries(this.adapters)) {
      try {
        const sessions = await adapter.list({ all: true });
        for (const session of sessions) {
          const existing = this.state.getSession(session.id);
          const record = sessionToRecord(session, adapterName);

          if (!existing) {
            this.state.setSession(session.id, record);
          } else if (existing.status !== record.status) {
            // Status changed — update
            this.state.setSession(session.id, {
              ...existing,
              status: record.status,
              stoppedAt: record.stoppedAt,
              tokens: record.tokens,
              cost: record.cost,
            });
          }
        }
      } catch {
        // Adapter unavailable — skip
      }
    }
  }

  /** Track a newly launched session */
  track(session: AgentSession, adapterName: string): SessionRecord {
    const record = sessionToRecord(session, adapterName);
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
  listSessions(opts?: { status?: string; all?: boolean }): SessionRecord[] {
    const sessions = Object.values(this.state.getSessions());
    let filtered = sessions;

    if (opts?.status) {
      filtered = filtered.filter((s) => s.status === opts.status);
    } else if (!opts?.all) {
      filtered = filtered.filter(
        (s) => s.status === "running" || s.status === "idle",
      );
    }

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
