import type { FuseEngine } from "./fuse-engine.js";
import type { LockManager } from "./lock-manager.js";
import type { SessionTracker } from "./session-tracker.js";

export class MetricsRegistry {
  sessionsTotalCompleted = 0;
  sessionsTotalFailed = 0;
  sessionsTotalStopped = 0;
  fusesFiredTotal = 0;
  clustersDeletedTotal = 0;
  sessionDurations: number[] = []; // seconds

  constructor(
    private sessionTracker: SessionTracker,
    private lockManager: LockManager,
    private fuseEngine: FuseEngine,
  ) {}

  recordSessionCompleted(durationSeconds?: number): void {
    this.sessionsTotalCompleted++;
    if (durationSeconds != null) this.sessionDurations.push(durationSeconds);
  }

  recordSessionFailed(durationSeconds?: number): void {
    this.sessionsTotalFailed++;
    if (durationSeconds != null) this.sessionDurations.push(durationSeconds);
  }

  recordSessionStopped(durationSeconds?: number): void {
    this.sessionsTotalStopped++;
    if (durationSeconds != null) this.sessionDurations.push(durationSeconds);
  }

  recordFuseFired(): void {
    this.fusesFiredTotal++;
    this.clustersDeletedTotal++;
  }

  generateMetrics(): string {
    const lines: string[] = [];

    const g = (name: string, help: string, value: number, labels?: string) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(labels ? `${name}{${labels}} ${value}` : `${name} ${value}`);
    };

    const c = (name: string, help: string, value: number, labels?: string) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(labels ? `${name}{${labels}} ${value}` : `${name} ${value}`);
    };

    // Gauges
    g(
      "agentctl_sessions_active",
      "Number of active sessions",
      this.sessionTracker.activeCount(),
    );

    const locks = this.lockManager.listAll();
    g(
      "agentctl_locks_active",
      "Number of active locks",
      locks.filter((l) => l.type === "auto").length,
      'type="auto"',
    );
    g(
      "agentctl_locks_active",
      "Number of active locks",
      locks.filter((l) => l.type === "manual").length,
      'type="manual"',
    );

    g(
      "agentctl_fuses_active",
      "Number of active fuse timers",
      this.fuseEngine.listActive().length,
    );

    // Counters
    c(
      "agentctl_sessions_total",
      "Total sessions by status",
      this.sessionsTotalCompleted,
      'status="completed"',
    );
    c(
      "agentctl_sessions_total",
      "Total sessions by status",
      this.sessionsTotalFailed,
      'status="failed"',
    );
    c(
      "agentctl_sessions_total",
      "Total sessions by status",
      this.sessionsTotalStopped,
      'status="stopped"',
    );

    c("agentctl_fuses_fired_total", "Total fuses fired", this.fusesFiredTotal);
    c(
      "agentctl_kind_clusters_deleted_total",
      "Total Kind clusters deleted",
      this.clustersDeletedTotal,
    );

    // Histogram (session duration)
    lines.push(
      "# HELP agentctl_session_duration_seconds Session duration histogram",
    );
    lines.push("# TYPE agentctl_session_duration_seconds histogram");
    const buckets = [60, 300, 600, 1800, 3600, 7200, Number.POSITIVE_INFINITY];
    for (const b of buckets) {
      const count = this.sessionDurations.filter((d) => d <= b).length;
      const label = b === Number.POSITIVE_INFINITY ? "+Inf" : String(b);
      lines.push(
        `agentctl_session_duration_seconds_bucket{le="${label}"} ${count}`,
      );
    }
    lines.push(
      `agentctl_session_duration_seconds_sum ${this.sessionDurations.reduce((a, b) => a + b, 0)}`,
    );
    lines.push(
      `agentctl_session_duration_seconds_count ${this.sessionDurations.length}`,
    );

    return `${lines.join("\n")}\n`;
  }
}
