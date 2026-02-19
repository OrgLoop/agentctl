import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../core/types.js";
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
});
