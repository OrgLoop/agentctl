import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentAdapter,
  AgentSession,
  DiscoveredSession,
} from "../core/types.js";
import { SessionTracker } from "./session-tracker.js";
import { StateManager } from "./state.js";

let tmpDir: string;
let state: StateManager;
let tracker: SessionTracker;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-tracker-test-"));
  state = await StateManager.load(tmpDir);
  tracker = new SessionTracker(state, { adapters: {} });
});

afterEach(async () => {
  tracker.stopLaunchCleanup();
  tracker.stopPendingResolution();
  state.flush();
  await fs.rm(tmpDir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
});

/** Create a mock adapter that returns fixed discovered sessions */
function mockAdapter(sessions: DiscoveredSession[]): AgentAdapter {
  return {
    id: "mock",
    discover: async () => sessions,
    isAlive: async () => false,
    list: async () => [],
    peek: async () => "",
    status: async () => ({
      id: "",
      adapter: "",
      status: "stopped",
      startedAt: new Date(),
      meta: {},
    }),
    launch: async () => ({
      id: "",
      adapter: "",
      status: "running",
      startedAt: new Date(),
      meta: {},
    }),
    stop: async () => {},
    resume: async () => {},
    events: async function* () {},
  } as AgentAdapter;
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "test-session-1",
    adapter: "claude-code",
    status: "running",
    startedAt: new Date(),
    cwd: "/tmp/test",
    meta: {},
    ...overrides,
  };
}

function makeDiscovered(
  overrides: Partial<DiscoveredSession> = {},
): DiscoveredSession {
  return {
    id: "disc-1",
    status: "running",
    adapter: "claude-code",
    startedAt: new Date(),
    cwd: "/tmp/test",
    ...overrides,
  };
}

describe("SessionTracker", () => {
  describe("track", () => {
    it("tracks a new session as launch metadata", () => {
      const session = makeSession();
      const record = tracker.track(session, "claude-code");

      expect(record.id).toBe("test-session-1");
      expect(record.adapter).toBe("claude-code");
      expect(record.status).toBe("running");
    });

    it("stores session in state", () => {
      const session = makeSession();
      tracker.track(session, "claude-code");

      expect(state.getSession("test-session-1")).toBeDefined();
    });

    it("removes pending-PID entry when real session registers with same PID", () => {
      tracker.track(
        makeSession({ id: "pending-11111", status: "running", pid: 11111 }),
        "claude-code",
      );
      expect(state.getSession("pending-11111")).toBeDefined();

      tracker.track(
        makeSession({
          id: "real-uuid-session",
          status: "running",
          pid: 11111,
        }),
        "claude-code",
      );

      expect(state.getSession("pending-11111")).toBeUndefined();
      expect(state.getSession("real-uuid-session")).toBeDefined();
    });
  });

  describe("getSession", () => {
    it("finds by exact ID", () => {
      tracker.track(makeSession(), "claude-code");
      const result = tracker.getSession("test-session-1");
      expect(result).toBeDefined();
      expect(result?.id).toBe("test-session-1");
    });

    it("finds by prefix", () => {
      tracker.track(makeSession(), "claude-code");
      const result = tracker.getSession("test-se");
      expect(result).toBeDefined();
      expect(result?.id).toBe("test-session-1");
    });

    it("returns undefined for unknown id", () => {
      expect(tracker.getSession("unknown")).toBeUndefined();
    });
  });

  describe("onSessionExit", () => {
    it("marks session as stopped", () => {
      tracker.track(
        makeSession({ id: "s1", status: "running" }),
        "claude-code",
      );

      const stopped = tracker.onSessionExit("s1");
      expect(stopped).toBeDefined();
      expect(stopped?.status).toBe("stopped");
      expect(stopped?.stoppedAt).toBeDefined();
    });

    it("returns undefined for unknown session", () => {
      expect(tracker.onSessionExit("unknown")).toBeUndefined();
    });
  });

  describe("removeSession", () => {
    it("removes a session from state", () => {
      tracker.track(
        makeSession({ id: "pending-55555", status: "running", pid: 55555 }),
        "claude-code",
      );
      expect(state.getSession("pending-55555")).toBeDefined();

      tracker.removeSession("pending-55555");
      expect(state.getSession("pending-55555")).toBeUndefined();
    });
  });

  describe("reconcileAndEnrich", () => {
    it("enriches discovered sessions with launch metadata", () => {
      // Pre-seed launch metadata with extra info
      tracker.track(
        makeSession({
          id: "s1",
          status: "running",
          prompt: "Fix the bug",
          group: "g-abc",
          spec: "/tmp/spec.md",
        }),
        "claude-code",
      );

      const discovered = [
        makeDiscovered({
          id: "s1",
          status: "running",
          adapter: "claude-code",
          pid: 1234,
        }),
      ];

      const { sessions } = tracker.reconcileAndEnrich(
        discovered,
        new Set(["claude-code"]),
      );

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("s1");
      expect(sessions[0].prompt).toBe("Fix the bug");
      expect(sessions[0].group).toBe("g-abc");
      expect(sessions[0].spec).toBe("/tmp/spec.md");
      expect(sessions[0].pid).toBe(1234);
    });

    it("returns discovered sessions without launch metadata", () => {
      // No launch metadata for this session
      const discovered = [
        makeDiscovered({
          id: "unknown-session",
          status: "running",
          adapter: "claude-code",
          model: "claude-4",
        }),
      ];

      const { sessions } = tracker.reconcileAndEnrich(
        discovered,
        new Set(["claude-code"]),
      );

      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("unknown-session");
      expect(sessions[0].model).toBe("claude-4");
      expect(sessions[0].prompt).toBeUndefined();
    });

    it("marks disappeared sessions as stopped when adapter succeeded", () => {
      // Session was launched 60+ seconds ago
      tracker.track(
        makeSession({
          id: "old-session",
          status: "running",
          startedAt: new Date(Date.now() - 120_000), // 2 minutes ago
        }),
        "claude-code",
      );

      // Adapter returns empty — session is gone
      const { sessions, stoppedLaunchIds } = tracker.reconcileAndEnrich(
        [],
        new Set(["claude-code"]),
      );

      expect(stoppedLaunchIds).toContain("old-session");
      expect(state.getSession("old-session")?.status).toBe("stopped");
      // Stopped session should NOT appear in results
      expect(sessions.map((s) => s.id)).not.toContain("old-session");
    });

    it("preserves recently-launched sessions within grace period", () => {
      // Session was launched just now
      tracker.track(
        makeSession({
          id: "new-session",
          status: "running",
          startedAt: new Date(), // just now
        }),
        "claude-code",
      );

      // Adapter hasn't discovered it yet
      const { sessions, stoppedLaunchIds } = tracker.reconcileAndEnrich(
        [],
        new Set(["claude-code"]),
      );

      expect(stoppedLaunchIds).not.toContain("new-session");
      expect(sessions.map((s) => s.id)).toContain("new-session");
      expect(state.getSession("new-session")?.status).toBe("running");
    });

    it("does not reconcile sessions whose adapter failed", () => {
      tracker.track(
        makeSession({
          id: "oc-session",
          status: "running",
          startedAt: new Date(Date.now() - 120_000),
        }),
        "openclaw",
      );

      // openclaw adapter failed (not in succeededAdapters)
      const { sessions, stoppedLaunchIds } = tracker.reconcileAndEnrich(
        [],
        new Set(["claude-code"]), // only claude-code succeeded
      );

      expect(stoppedLaunchIds).not.toContain("oc-session");
      // Session should still be included (from launch metadata)
      expect(sessions.map((s) => s.id)).toContain("oc-session");
      expect(state.getSession("oc-session")?.status).toBe("running");
    });

    it("handles pending→UUID resolution via PID match", () => {
      // pending entry was launched 2 min ago
      tracker.track(
        makeSession({
          id: "pending-99999",
          status: "running",
          pid: 99999,
          startedAt: new Date(Date.now() - 120_000),
        }),
        "claude-code",
      );

      // Adapter returns a resolved session with the same PID but different ID
      const discovered = [
        makeDiscovered({
          id: "real-uuid",
          status: "running",
          adapter: "claude-code",
          pid: 99999,
        }),
      ];

      const { sessions, stoppedLaunchIds } = tracker.reconcileAndEnrich(
        discovered,
        new Set(["claude-code"]),
      );

      // pending entry should be cleaned up
      expect(stoppedLaunchIds).toContain("pending-99999");
      expect(state.getSession("pending-99999")).toBeUndefined();
      // Real session should be in results
      expect(sessions.map((s) => s.id)).toContain("real-uuid");
    });

    it("merges results from multiple adapters", () => {
      const discovered = [
        makeDiscovered({
          id: "cc-1",
          status: "running",
          adapter: "claude-code",
        }),
        makeDiscovered({
          id: "oc-1",
          status: "running",
          adapter: "openclaw",
        }),
        makeDiscovered({
          id: "pi-1",
          status: "stopped",
          adapter: "pi",
        }),
      ];

      const { sessions } = tracker.reconcileAndEnrich(
        discovered,
        new Set(["claude-code", "openclaw", "pi"]),
      );

      expect(sessions).toHaveLength(3);
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain("cc-1");
      expect(ids).toContain("oc-1");
      expect(ids).toContain("pi-1");
    });

    it("does not mark stopped sessions as stopped again", () => {
      // Already stopped in launch metadata
      tracker.track(
        makeSession({
          id: "already-stopped",
          status: "stopped",
          startedAt: new Date(Date.now() - 120_000),
        }),
        "claude-code",
      );

      const { stoppedLaunchIds } = tracker.reconcileAndEnrich(
        [],
        new Set(["claude-code"]),
      );

      // Should not try to stop it again
      expect(stoppedLaunchIds).not.toContain("already-stopped");
    });
  });

  describe("cleanupDeadLaunches", () => {
    it("marks sessions with dead PIDs as stopped", () => {
      const deadTracker = new SessionTracker(state, {
        adapters: {},
        isProcessAlive: () => false,
      });

      deadTracker.track(
        makeSession({ id: "s1", status: "running", pid: 12345 }),
        "claude-code",
      );

      const dead = deadTracker.cleanupDeadLaunches();

      expect(dead).toContain("s1");
      expect(state.getSession("s1")?.status).toBe("stopped");
      expect(state.getSession("s1")?.stoppedAt).toBeDefined();
    });

    it("does not mark sessions with live PIDs as stopped", () => {
      const liveTracker = new SessionTracker(state, {
        adapters: {},
        isProcessAlive: () => true,
      });

      liveTracker.track(
        makeSession({ id: "s1", status: "running", pid: 12345 }),
        "claude-code",
      );

      const dead = liveTracker.cleanupDeadLaunches();

      expect(dead).toHaveLength(0);
      expect(state.getSession("s1")?.status).toBe("running");
    });

    it("skips already-stopped sessions", () => {
      tracker.track(
        makeSession({ id: "s1", status: "stopped", pid: 12345 }),
        "claude-code",
      );

      const dead = tracker.cleanupDeadLaunches();
      expect(dead).toHaveLength(0);
    });

    it("handles sessions without PIDs (no change)", () => {
      tracker.track(
        makeSession({ id: "s1", status: "running" }),
        "claude-code",
      );

      const dead = tracker.cleanupDeadLaunches();
      expect(dead).toHaveLength(0);
      expect(state.getSession("s1")?.status).toBe("running");
    });
  });

  describe("startLaunchCleanup / stopLaunchCleanup", () => {
    it("periodically checks PID liveness", async () => {
      vi.useFakeTimers();

      const onDead = vi.fn();
      const deadTracker = new SessionTracker(state, {
        adapters: {},
        isProcessAlive: () => false,
      });

      deadTracker.track(
        makeSession({ id: "s1", status: "running", pid: 12345 }),
        "claude-code",
      );

      deadTracker.startLaunchCleanup(onDead);

      // Advance past the 30s interval
      vi.advanceTimersByTime(30_000);

      expect(onDead).toHaveBeenCalledWith("s1");

      deadTracker.stopLaunchCleanup();
      state.flush();
      vi.useRealTimers();
    });
  });

  describe("resolvePendingId", () => {
    it("resolves pending-PID to real UUID via adapter discover", async () => {
      const adapter = mockAdapter([
        makeDiscovered({ id: "real-uuid-abc", status: "running", pid: 42000 }),
      ]);
      const resolveTracker = new SessionTracker(state, {
        adapters: { "claude-code": adapter },
      });

      resolveTracker.track(
        makeSession({ id: "pending-42000", status: "running", pid: 42000 }),
        "claude-code",
      );

      const resolved = await resolveTracker.resolvePendingId("pending-42000");

      expect(resolved).toBe("real-uuid-abc");
      expect(state.getSession("pending-42000")).toBeUndefined();
      expect(state.getSession("real-uuid-abc")).toBeDefined();
      expect(state.getSession("real-uuid-abc")?.pid).toBe(42000);
    });

    it("returns original ID for non-pending IDs", async () => {
      const resolved = await tracker.resolvePendingId("normal-uuid");
      expect(resolved).toBe("normal-uuid");
    });

    it("returns original ID when no matching PID found", async () => {
      const adapter = mockAdapter([
        makeDiscovered({ id: "other-uuid", status: "running", pid: 99999 }),
      ]);
      const resolveTracker = new SessionTracker(state, {
        adapters: { "claude-code": adapter },
      });

      resolveTracker.track(
        makeSession({ id: "pending-42000", status: "running", pid: 42000 }),
        "claude-code",
      );

      const resolved = await resolveTracker.resolvePendingId("pending-42000");
      expect(resolved).toBe("pending-42000");
      expect(state.getSession("pending-42000")).toBeDefined();
    });

    it("returns original ID when adapter discovery fails", async () => {
      const failAdapter = mockAdapter([]);
      failAdapter.discover = async () => {
        throw new Error("adapter offline");
      };
      const resolveTracker = new SessionTracker(state, {
        adapters: { "claude-code": failAdapter },
      });

      resolveTracker.track(
        makeSession({ id: "pending-42000", status: "running", pid: 42000 }),
        "claude-code",
      );

      const resolved = await resolveTracker.resolvePendingId("pending-42000");
      expect(resolved).toBe("pending-42000");
    });

    it("preserves launch metadata (prompt, group, spec) after resolution", async () => {
      const adapter = mockAdapter([
        makeDiscovered({ id: "real-uuid", status: "running", pid: 42000 }),
      ]);
      const resolveTracker = new SessionTracker(state, {
        adapters: { "claude-code": adapter },
      });

      resolveTracker.track(
        makeSession({
          id: "pending-42000",
          status: "running",
          pid: 42000,
          prompt: "Fix the bug",
          group: "g-test",
          spec: "/tmp/spec.md",
        }),
        "claude-code",
      );

      await resolveTracker.resolvePendingId("pending-42000");

      const record = state.getSession("real-uuid");
      expect(record?.prompt).toBe("Fix the bug");
      expect(record?.group).toBe("g-test");
      expect(record?.spec).toBe("/tmp/spec.md");
      expect(record?.id).toBe("real-uuid");
    });

    it("returns original ID when session has no PID", async () => {
      tracker.track(
        makeSession({ id: "pending-nopid", status: "running" }),
        "claude-code",
      );

      const resolved = await tracker.resolvePendingId("pending-nopid");
      expect(resolved).toBe("pending-nopid");
    });
  });

  describe("resolvePendingSessions", () => {
    it("batch-resolves multiple pending sessions", async () => {
      const adapter = mockAdapter([
        makeDiscovered({ id: "uuid-1", status: "running", pid: 1001 }),
        makeDiscovered({ id: "uuid-2", status: "running", pid: 1002 }),
      ]);
      const resolveTracker = new SessionTracker(state, {
        adapters: { "claude-code": adapter },
      });

      resolveTracker.track(
        makeSession({ id: "pending-1001", status: "running", pid: 1001 }),
        "claude-code",
      );
      resolveTracker.track(
        makeSession({ id: "pending-1002", status: "running", pid: 1002 }),
        "claude-code",
      );

      const resolved = await resolveTracker.resolvePendingSessions();

      expect(resolved.size).toBe(2);
      expect(resolved.get("pending-1001")).toBe("uuid-1");
      expect(resolved.get("pending-1002")).toBe("uuid-2");
      expect(state.getSession("pending-1001")).toBeUndefined();
      expect(state.getSession("pending-1002")).toBeUndefined();
      expect(state.getSession("uuid-1")).toBeDefined();
      expect(state.getSession("uuid-2")).toBeDefined();
    });

    it("skips stopped pending sessions", async () => {
      const adapter = mockAdapter([
        makeDiscovered({ id: "uuid-1", status: "running", pid: 1001 }),
      ]);
      const resolveTracker = new SessionTracker(state, {
        adapters: { "claude-code": adapter },
      });

      resolveTracker.track(
        makeSession({ id: "pending-1001", status: "stopped", pid: 1001 }),
        "claude-code",
      );

      const resolved = await resolveTracker.resolvePendingSessions();
      expect(resolved.size).toBe(0);
    });

    it("returns empty map when no pending sessions exist", async () => {
      const resolved = await tracker.resolvePendingSessions();
      expect(resolved.size).toBe(0);
    });

    it("groups discover calls by adapter", async () => {
      const ccDiscover = vi
        .fn()
        .mockResolvedValue([
          makeDiscovered({ id: "cc-uuid", status: "running", pid: 2001 }),
        ]);
      const piDiscover = vi
        .fn()
        .mockResolvedValue([
          makeDiscovered({ id: "pi-uuid", status: "running", pid: 2002 }),
        ]);

      const ccAdapter = mockAdapter([]);
      ccAdapter.discover = ccDiscover;
      const piAdapter = mockAdapter([]);
      piAdapter.discover = piDiscover;

      const resolveTracker = new SessionTracker(state, {
        adapters: { "claude-code": ccAdapter, pi: piAdapter },
      });

      resolveTracker.track(
        makeSession({ id: "pending-2001", status: "running", pid: 2001 }),
        "claude-code",
      );
      resolveTracker.track(
        makeSession({ id: "pending-2002", status: "running", pid: 2002 }),
        "pi",
      );

      const resolved = await resolveTracker.resolvePendingSessions();

      expect(resolved.size).toBe(2);
      expect(ccDiscover).toHaveBeenCalledTimes(1);
      expect(piDiscover).toHaveBeenCalledTimes(1);
    });
  });

  describe("startPendingResolution / stopPendingResolution", () => {
    it("periodically resolves pending sessions", async () => {
      vi.useFakeTimers();

      const adapter = mockAdapter([
        makeDiscovered({ id: "uuid-bg", status: "running", pid: 7777 }),
      ]);
      const resolveTracker = new SessionTracker(state, {
        adapters: { "claude-code": adapter },
      });

      resolveTracker.track(
        makeSession({ id: "pending-7777", status: "running", pid: 7777 }),
        "claude-code",
      );

      const onResolved = vi.fn();
      resolveTracker.startPendingResolution(onResolved);

      // Advance past the 10s interval
      await vi.advanceTimersByTimeAsync(10_000);

      expect(onResolved).toHaveBeenCalledWith("pending-7777", "uuid-bg");

      resolveTracker.stopPendingResolution();
      state.flush();
      vi.useRealTimers();
    });
  });
});
