import type {
  AgentAdapter,
  AgentSession,
  DiscoveredSession,
} from "../core/types.js";
import type { SessionRecord, StateManager } from "./state.js";

export interface SessionTrackerOpts {
  adapters: Record<string, AgentAdapter>;
  /** Override PID liveness check for testing (default: process.kill(pid, 0)) */
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Grace period for recently-launched sessions.
 * If a session was launched less than this many ms ago and the adapter
 * doesn't return it yet, don't mark it stopped — the adapter may not
 * have discovered it yet.
 */
const LAUNCH_GRACE_PERIOD_MS = 30_000;

/**
 * Simplified session tracker for the stateless daemon core (ADR 004).
 *
 * Adapters own session truth. The daemon only tracks:
 * - Launch metadata (prompt, group, spec, cwd) for sessions launched via agentctl
 * - Locks and fuses (handled by LockManager / FuseEngine)
 *
 * The old polling loop, pruning, and state-based session registry are removed.
 * session.list now fans out adapter.discover() at call time.
 */
export class SessionTracker {
  private state: StateManager;
  private adapters: Record<string, AgentAdapter>;
  private readonly isProcessAlive: (pid: number) => boolean;
  private cleanupHandle: ReturnType<typeof setInterval> | null = null;
  private pendingResolutionHandle: ReturnType<typeof setInterval> | null = null;

  constructor(state: StateManager, opts: SessionTrackerOpts) {
    this.state = state;
    this.adapters = opts.adapters;
    this.isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  }

  /**
   * Start periodic PID liveness check for daemon-launched sessions.
   * This is a lightweight check (no adapter fan-out) that runs every 30s
   * to detect dead sessions and return their IDs for lock cleanup.
   */
  startLaunchCleanup(onDead?: (sessionId: string) => void): void {
    if (this.cleanupHandle) return;
    this.cleanupHandle = setInterval(() => {
      const dead = this.cleanupDeadLaunches();
      if (onDead) {
        for (const id of dead) onDead(id);
      }
    }, 30_000);
  }

  stopLaunchCleanup(): void {
    if (this.cleanupHandle) {
      clearInterval(this.cleanupHandle);
      this.cleanupHandle = null;
    }
  }

  /**
   * Start periodic background resolution of pending-* session IDs.
   * Runs every 10s, discovers real UUIDs via adapter PID matching.
   */
  startPendingResolution(
    onResolved?: (oldId: string, newId: string) => void,
  ): void {
    if (this.pendingResolutionHandle) return;
    this.pendingResolutionHandle = setInterval(async () => {
      const resolved = await this.resolvePendingSessions();
      if (onResolved) {
        for (const [oldId, newId] of resolved) {
          onResolved(oldId, newId);
        }
      }
    }, 10_000);
  }

  stopPendingResolution(): void {
    if (this.pendingResolutionHandle) {
      clearInterval(this.pendingResolutionHandle);
      this.pendingResolutionHandle = null;
    }
  }

  /**
   * Resolve a single pending-* session ID on demand.
   * Returns the resolved real UUID, or the original ID if resolution fails.
   */
  async resolvePendingId(id: string): Promise<string> {
    if (!id.startsWith("pending-")) return id;

    const record = this.getSession(id);
    if (!record || !record.pid) return id;

    const adapter = this.adapters[record.adapter];
    if (!adapter) return id;

    try {
      const discovered = await adapter.discover();
      const match = discovered.find((d) => d.pid === record.pid);
      if (match && match.id !== id) {
        // Resolve: move state from pending ID to real UUID
        const updatedRecord: SessionRecord = { ...record, id: match.id };
        this.state.removeSession(id);
        this.state.setSession(match.id, updatedRecord);
        return match.id;
      }
    } catch {
      // Adapter failed — return original ID
    }

    return id;
  }

  /**
   * Batch-resolve all pending-* session IDs via adapter discovery.
   * Groups pending sessions by adapter to minimize discover() calls.
   * Returns a map of oldId → newId for each resolved session.
   */
  async resolvePendingSessions(): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    const sessions = this.state.getSessions();

    // Group pending sessions by adapter
    const pendingByAdapter = new Map<
      string,
      Array<{ id: string; record: SessionRecord }>
    >();
    for (const [id, record] of Object.entries(sessions)) {
      if (!id.startsWith("pending-")) continue;
      if (record.status === "stopped" || record.status === "completed")
        continue;
      if (!record.pid) continue;

      const list = pendingByAdapter.get(record.adapter) || [];
      list.push({ id, record });
      pendingByAdapter.set(record.adapter, list);
    }

    if (pendingByAdapter.size === 0) return resolved;

    // For each adapter with pending sessions, run discover() once
    for (const [adapterName, pendings] of pendingByAdapter) {
      const adapter = this.adapters[adapterName];
      if (!adapter) continue;

      try {
        const discovered = await adapter.discover();
        const pidToId = new Map<number, string>();
        for (const d of discovered) {
          if (d.pid) pidToId.set(d.pid, d.id);
        }

        for (const { id, record } of pendings) {
          if (!record.pid) continue;
          const resolvedId = pidToId.get(record.pid);
          if (resolvedId && resolvedId !== id) {
            const updatedRecord: SessionRecord = { ...record, id: resolvedId };
            this.state.removeSession(id);
            this.state.setSession(resolvedId, updatedRecord);
            resolved.set(id, resolvedId);
          }
        }
      } catch {
        // Adapter failed — skip
      }
    }

    return resolved;
  }

  /** Track a newly launched session (stores launch metadata in state) */
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

  /** Get session launch metadata by id (exact or prefix match) */
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

  /** Remove a session from launch metadata */
  removeSession(sessionId: string): void {
    this.state.removeSession(sessionId);
  }

  /** Called when a session stops — marks it in launch metadata, returns the record */
  onSessionExit(sessionId: string): SessionRecord | undefined {
    const session = this.state.getSession(sessionId);
    if (session) {
      session.status = "stopped";
      session.stoppedAt = new Date().toISOString();
      this.state.setSession(sessionId, session);
    }
    return session;
  }

  /**
   * Merge adapter-discovered sessions with daemon launch metadata.
   *
   * 1. Enrich discovered sessions with launch metadata (prompt, group, spec, etc.)
   * 2. Reconcile: mark daemon-launched sessions as stopped if their adapter
   *    succeeded but didn't return them (and they're past the grace period).
   * 3. Include recently-launched sessions that adapters haven't discovered yet.
   *
   * Returns the merged session list and IDs of sessions that were marked stopped
   * (for lock cleanup by the caller).
   */
  reconcileAndEnrich(
    discovered: DiscoveredSession[],
    succeededAdapters: Set<string>,
  ): { sessions: SessionRecord[]; stoppedLaunchIds: string[] } {
    // Build lookups for discovered sessions
    const discoveredIds = new Set(discovered.map((d) => d.id));
    const discoveredPids = new Map<number, string>();
    for (const d of discovered) {
      if (d.pid) discoveredPids.set(d.pid, d.id);
    }

    // 1. Convert discovered sessions to records, enriching with launch metadata
    const sessions: SessionRecord[] = discovered.map((disc) =>
      enrichDiscovered(disc, this.state.getSession(disc.id)),
    );

    // 2. Reconcile daemon-launched sessions that disappeared from adapter results
    const stoppedLaunchIds: string[] = [];
    const now = Date.now();

    for (const [id, record] of Object.entries(this.state.getSessions())) {
      if (
        record.status !== "running" &&
        record.status !== "idle" &&
        record.status !== "pending"
      )
        continue;

      // If adapter for this session didn't succeed, include as-is from launch metadata
      // (we can't verify status, so trust the last-known state)
      if (!succeededAdapters.has(record.adapter)) {
        sessions.push(record);
        continue;
      }

      // Skip if adapter returned this session (it's still active)
      if (discoveredIds.has(id)) continue;

      // Check if this session's PID was resolved to a different ID (pending→UUID)
      if (record.pid && discoveredPids.has(record.pid)) {
        // PID was resolved to a real session — remove stale launch entry
        this.state.removeSession(id);
        stoppedLaunchIds.push(id);
        continue;
      }

      // Grace period: don't mark recently-launched sessions as stopped
      const launchAge = now - new Date(record.startedAt).getTime();
      if (launchAge < LAUNCH_GRACE_PERIOD_MS) {
        // Still within grace period — include as-is in results
        sessions.push(record);
        continue;
      }

      // Session disappeared from adapter results — mark stopped
      this.state.setSession(id, {
        ...record,
        status: "stopped",
        stoppedAt: new Date().toISOString(),
      });
      stoppedLaunchIds.push(id);
    }

    return { sessions, stoppedLaunchIds };
  }

  /**
   * Check PID liveness for daemon-launched sessions.
   * Returns IDs of sessions whose PIDs have died.
   * This is a lightweight check (no adapter fan-out) for lock cleanup.
   */
  cleanupDeadLaunches(): string[] {
    const dead: string[] = [];
    for (const [id, record] of Object.entries(this.state.getSessions())) {
      if (
        record.status !== "running" &&
        record.status !== "idle" &&
        record.status !== "pending"
      )
        continue;

      if (record.pid && !this.isProcessAlive(record.pid)) {
        this.state.setSession(id, {
          ...record,
          status: "stopped",
          stoppedAt: new Date().toISOString(),
        });
        dead.push(id);
      }
    }
    return dead;
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
 * Convert a discovered session to a SessionRecord, enriching with launch metadata.
 */
function enrichDiscovered(
  disc: DiscoveredSession,
  launchMeta: SessionRecord | undefined,
): SessionRecord {
  return {
    id: disc.id,
    adapter: disc.adapter,
    status: disc.status as SessionRecord["status"],
    startedAt: disc.startedAt?.toISOString() ?? new Date().toISOString(),
    stoppedAt: disc.stoppedAt?.toISOString(),
    cwd: disc.cwd ?? launchMeta?.cwd,
    model: disc.model ?? launchMeta?.model,
    prompt: disc.prompt ?? launchMeta?.prompt,
    tokens: disc.tokens,
    cost: disc.cost,
    pid: disc.pid,
    spec: launchMeta?.spec,
    group: launchMeta?.group,
    meta: disc.nativeMetadata ?? launchMeta?.meta ?? {},
  };
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
    group: session.group,
    meta: session.meta,
  };
}
