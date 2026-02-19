import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FuseEngine } from "./fuse-engine.js";
import { LockManager } from "./lock-manager.js";
import { MetricsRegistry } from "./metrics.js";
import { SessionTracker } from "./session-tracker.js";
import { StateManager } from "./state.js";

let tmpDir: string;
let state: StateManager;
let metrics: MetricsRegistry;
let lockManager: LockManager;
let fuseEngine: FuseEngine;
let sessionTracker: SessionTracker;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-metrics-test-"));
  state = await StateManager.load(tmpDir);
  lockManager = new LockManager(state);
  fuseEngine = new FuseEngine(state, { defaultDurationMs: 600000 });
  sessionTracker = new SessionTracker(state, { adapters: {} });
  metrics = new MetricsRegistry(sessionTracker, lockManager, fuseEngine);
});

afterEach(async () => {
  fuseEngine.shutdown();
  state.flush();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("MetricsRegistry", () => {
  describe("generateMetrics", () => {
    it("produces valid Prometheus text format", () => {
      const output = metrics.generateMetrics();

      // Should contain HELP and TYPE annotations
      expect(output).toContain("# HELP agentctl_sessions_active");
      expect(output).toContain("# TYPE agentctl_sessions_active gauge");
      expect(output).toContain("agentctl_sessions_active 0");

      // Should contain lock metrics
      expect(output).toContain("agentctl_locks_active");

      // Should contain fuse metrics
      expect(output).toContain("agentctl_fuses_active 0");

      // Should contain counter metrics
      expect(output).toContain("# TYPE agentctl_sessions_total counter");
      expect(output).toContain('agentctl_sessions_total{status="completed"} 0');
      expect(output).toContain('agentctl_sessions_total{status="failed"} 0');
      expect(output).toContain('agentctl_sessions_total{status="stopped"} 0');

      // Should contain histogram
      expect(output).toContain(
        "# TYPE agentctl_session_duration_seconds histogram",
      );
      expect(output).toContain("agentctl_session_duration_seconds_bucket");
      expect(output).toContain("agentctl_session_duration_seconds_sum");
      expect(output).toContain("agentctl_session_duration_seconds_count");

      // End with newline
      expect(output).toMatch(/\n$/);
    });

    it("reflects counters after recording events", () => {
      metrics.recordSessionCompleted(120);
      metrics.recordSessionCompleted(300);
      metrics.recordSessionFailed(60);
      metrics.recordSessionStopped(45);
      metrics.recordFuseFired();

      const output = metrics.generateMetrics();

      expect(output).toContain('agentctl_sessions_total{status="completed"} 2');
      expect(output).toContain('agentctl_sessions_total{status="failed"} 1');
      expect(output).toContain('agentctl_sessions_total{status="stopped"} 1');
      expect(output).toContain("agentctl_fuses_fired_total 1");
      expect(output).toContain("agentctl_kind_clusters_deleted_total 1");
    });

    it("computes histogram buckets correctly", () => {
      metrics.recordSessionCompleted(30); // ≤ 60
      metrics.recordSessionCompleted(120); // ≤ 300
      metrics.recordSessionCompleted(500); // ≤ 600
      metrics.recordSessionCompleted(5000); // ≤ 7200

      const output = metrics.generateMetrics();

      expect(output).toContain(
        'agentctl_session_duration_seconds_bucket{le="60"} 1',
      );
      expect(output).toContain(
        'agentctl_session_duration_seconds_bucket{le="300"} 2',
      );
      expect(output).toContain(
        'agentctl_session_duration_seconds_bucket{le="600"} 3',
      );
      expect(output).toContain(
        'agentctl_session_duration_seconds_bucket{le="7200"} 4',
      );
      expect(output).toContain(
        'agentctl_session_duration_seconds_bucket{le="+Inf"} 4',
      );
      expect(output).toContain("agentctl_session_duration_seconds_sum 5650");
      expect(output).toContain("agentctl_session_duration_seconds_count 4");
    });

    it("reflects live lock counts", () => {
      lockManager.autoLock("/tmp/a", "s1");
      lockManager.autoLock("/tmp/b", "s2");
      lockManager.manualLock("/tmp/c", "user", "reason");

      const output = metrics.generateMetrics();
      expect(output).toContain('agentctl_locks_active{type="auto"} 2');
      expect(output).toContain('agentctl_locks_active{type="manual"} 1');
    });
  });
});
