import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  tracker.stopPolling();
  state.flush();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

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

describe("SessionTracker", () => {
  describe("track", () => {
    it("tracks a new session", () => {
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

  describe("listSessions", () => {
    it("lists all active sessions by default", () => {
      tracker.track(
        makeSession({ id: "s1", status: "running" }),
        "claude-code",
      );
      tracker.track(makeSession({ id: "s2", status: "idle" }), "claude-code");
      tracker.track(
        makeSession({ id: "s3", status: "stopped" }),
        "claude-code",
      );

      const list = tracker.listSessions();
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.id)).toContain("s1");
      expect(list.map((s) => s.id)).toContain("s2");
    });

    it("includes all sessions with all flag", () => {
      tracker.track(
        makeSession({ id: "s1", status: "running" }),
        "claude-code",
      );
      tracker.track(
        makeSession({ id: "s2", status: "stopped" }),
        "claude-code",
      );

      const list = tracker.listSessions({ all: true });
      expect(list).toHaveLength(2);
    });

    it("filters by status", () => {
      tracker.track(
        makeSession({ id: "s1", status: "running" }),
        "claude-code",
      );
      tracker.track(
        makeSession({ id: "s2", status: "stopped" }),
        "claude-code",
      );

      const list = tracker.listSessions({ status: "stopped" });
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe("s2");
    });

    it("sorts running sessions first", () => {
      tracker.track(
        makeSession({
          id: "s1",
          status: "idle",
          startedAt: new Date("2025-01-02"),
        }),
        "claude-code",
      );
      tracker.track(
        makeSession({
          id: "s2",
          status: "running",
          startedAt: new Date("2025-01-01"),
        }),
        "claude-code",
      );

      const list = tracker.listSessions();
      expect(list[0].id).toBe("s2"); // running comes first
    });
  });

  describe("activeCount", () => {
    it("counts running and idle sessions", () => {
      tracker.track(
        makeSession({ id: "s1", status: "running" }),
        "claude-code",
      );
      tracker.track(makeSession({ id: "s2", status: "idle" }), "claude-code");
      tracker.track(
        makeSession({ id: "s3", status: "stopped" }),
        "claude-code",
      );

      expect(tracker.activeCount()).toBe(2);
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

  describe("ghost session reaping (issue #22)", () => {
    /** Create a mock adapter that returns the given sessions from discover() and list() */
    function mockAdapter(sessions: AgentSession[]): AgentAdapter {
      const discovered: DiscoveredSession[] = sessions.map((s) => ({
        id: s.id,
        status: s.status === "running" ? "running" : "stopped",
        adapter: s.adapter,
        cwd: s.cwd,
        model: s.model,
        startedAt: s.startedAt,
        stoppedAt: s.stoppedAt,
        pid: s.pid,
        prompt: s.prompt,
        tokens: s.tokens,
        cost: s.cost,
      }));
      return {
        id: "mock",
        discover: async () => discovered,
        isAlive: async (id) =>
          discovered.some((d) => d.id === id && d.status === "running"),
        list: async () => sessions,
        peek: async () => "",
        status: async () => sessions[0],
        launch: async () => sessions[0],
        stop: async () => {},
        resume: async () => {},
        async *events() {},
      };
    }

    it("marks dead PID sessions as stopped during poll", async () => {
      // Pre-seed state with a "running" session whose PID is dead
      tracker.track(
        makeSession({ id: "pending-12345", status: "running", pid: 12345 }),
        "claude-code",
      );

      // Create tracker with dead-PID checker and an adapter that returns nothing
      const reapTracker = new SessionTracker(state, {
        adapters: { "claude-code": mockAdapter([]) },
        isProcessAlive: () => false,
      });

      // Trigger a poll cycle
      reapTracker.startPolling();
      // Wait for poll to complete
      await new Promise((r) => setTimeout(r, 100));
      reapTracker.stopPolling();

      const session = state.getSession("pending-12345");
      expect(session?.status).toBe("stopped");
      expect(session?.stoppedAt).toBeDefined();
    });

    it("removes pending-* entry when resolved session exists with same PID", async () => {
      // Pre-seed state with a pending entry
      tracker.track(
        makeSession({ id: "pending-99999", status: "running", pid: 99999 }),
        "claude-code",
      );

      // Adapter returns a resolved session with the same PID
      const resolvedSession = makeSession({
        id: "abc123-real-session-id",
        status: "running",
        pid: 99999,
      });

      const reapTracker = new SessionTracker(state, {
        adapters: { "claude-code": mockAdapter([resolvedSession]) },
        isProcessAlive: (pid) => pid === 99999,
      });

      reapTracker.startPolling();
      await new Promise((r) => setTimeout(r, 100));
      reapTracker.stopPolling();

      // pending-* entry should be removed
      expect(state.getSession("pending-99999")).toBeUndefined();
      // Real session should exist
      expect(state.getSession("abc123-real-session-id")).toBeDefined();
      expect(state.getSession("abc123-real-session-id")?.status).toBe(
        "running",
      );
    });

    it("live PID sessions still show as running after poll", async () => {
      tracker.track(
        makeSession({ id: "live-session", status: "running", pid: 55555 }),
        "claude-code",
      );

      // Adapter returns this session as running
      const liveSession = makeSession({
        id: "live-session",
        status: "running",
        pid: 55555,
      });

      const reapTracker = new SessionTracker(state, {
        adapters: { "claude-code": mockAdapter([liveSession]) },
        isProcessAlive: (pid) => pid === 55555,
      });

      reapTracker.startPolling();
      await new Promise((r) => setTimeout(r, 100));
      reapTracker.stopPolling();

      const session = state.getSession("live-session");
      expect(session?.status).toBe("running");
      expect(session?.pid).toBe(55555);
    });

    it("listSessions deduplicates pending-* vs resolved entries by PID", () => {
      // Both entries exist in state
      tracker.track(
        makeSession({ id: "pending-77777", status: "running", pid: 77777 }),
        "claude-code",
      );
      tracker.track(
        makeSession({
          id: "real-session-uuid",
          status: "running",
          pid: 77777,
        }),
        "claude-code",
      );

      const list = tracker.listSessions({ all: true });
      // Only the resolved session should appear
      const ids = list.map((s) => s.id);
      expect(ids).toContain("real-session-uuid");
      expect(ids).not.toContain("pending-77777");
    });

    it("keeps pending-* entry if no resolved session shares its PID", () => {
      // Only a pending entry, no resolved session with same PID
      tracker.track(
        makeSession({ id: "pending-44444", status: "running", pid: 44444 }),
        "claude-code",
      );
      tracker.track(
        makeSession({
          id: "different-session",
          status: "running",
          pid: 88888,
        }),
        "claude-code",
      );

      const list = tracker.listSessions({ all: true });
      const ids = list.map((s) => s.id);
      expect(ids).toContain("pending-44444");
      expect(ids).toContain("different-session");
    });
  });

  describe("ghost pending sessions (issue #27)", () => {
    it("track() removes pending-PID entry when real UUID session registers with same PID", () => {
      // Step 1: pending entry is created at launch time
      tracker.track(
        makeSession({ id: "pending-11111", status: "running", pid: 11111 }),
        "claude-code",
      );
      expect(state.getSession("pending-11111")).toBeDefined();

      // Step 2: real session registers with the same PID
      tracker.track(
        makeSession({
          id: "real-uuid-session",
          status: "running",
          pid: 11111,
        }),
        "claude-code",
      );

      // pending entry should be consumed
      expect(state.getSession("pending-11111")).toBeUndefined();
      // real session should exist
      expect(state.getSession("real-uuid-session")).toBeDefined();
      expect(state.getSession("real-uuid-session")?.status).toBe("running");
    });

    it("listSessions marks running sessions with dead PIDs as stopped", () => {
      // Create tracker with dead-PID checker
      const deadPidTracker = new SessionTracker(state, {
        adapters: {},
        isProcessAlive: () => false,
      });

      // Track a running session with a PID that will be "dead"
      deadPidTracker.track(
        makeSession({ id: "ghost-session", status: "running", pid: 22222 }),
        "claude-code",
      );

      // Listing should detect the dead PID and mark it stopped
      const list = deadPidTracker.listSessions({ all: true });
      const ghost = list.find((s) => s.id === "ghost-session");
      expect(ghost?.status).toBe("stopped");
      expect(ghost?.stoppedAt).toBeDefined();

      // State should also be updated
      const record = state.getSession("ghost-session");
      expect(record?.status).toBe("stopped");
    });

    it("listSessions does not mark sessions with live PIDs as stopped", () => {
      const livePidTracker = new SessionTracker(state, {
        adapters: {},
        isProcessAlive: () => true,
      });

      livePidTracker.track(
        makeSession({ id: "live-session", status: "running", pid: 33333 }),
        "claude-code",
      );

      const list = livePidTracker.listSessions();
      const live = list.find((s) => s.id === "live-session");
      expect(live?.status).toBe("running");
    });

    it("removeSession removes a session from state", () => {
      tracker.track(
        makeSession({ id: "pending-55555", status: "running", pid: 55555 }),
        "claude-code",
      );
      expect(state.getSession("pending-55555")).toBeDefined();

      tracker.removeSession("pending-55555");
      expect(state.getSession("pending-55555")).toBeUndefined();
    });
  });
});
