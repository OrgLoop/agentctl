import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FuseTimer, Lock } from "./state.js";
import { StateManager } from "./state.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-state-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("StateManager", () => {
  describe("load", () => {
    it("creates config directory on first load", async () => {
      const configDir = path.join(tmpDir, "new-dir");
      await StateManager.load(configDir);
      const stat = await fs.stat(configDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("loads empty state when no files exist", async () => {
      const state = await StateManager.load(tmpDir);
      expect(state.getSessions()).toEqual({});
      expect(state.getLocks()).toEqual([]);
      expect(state.getFuses()).toEqual([]);
    });

    it("loads existing state from files", async () => {
      // Pre-populate state files
      await fs.writeFile(
        path.join(tmpDir, "state.json"),
        JSON.stringify({
          sessions: {
            "test-1": {
              id: "test-1",
              adapter: "claude-code",
              status: "running",
              startedAt: "2025-01-01T00:00:00Z",
              meta: {},
            },
          },
          version: 1,
        }),
      );
      await fs.writeFile(
        path.join(tmpDir, "locks.json"),
        JSON.stringify([
          {
            directory: "/tmp/test",
            type: "manual",
            lockedBy: "user",
            lockedAt: "2025-01-01T00:00:00Z",
          },
        ]),
      );
      await fs.writeFile(
        path.join(tmpDir, "fuses.json"),
        JSON.stringify([
          {
            directory: "/tmp/mono-test",
            clusterName: "kindo-charlie-test",
            branch: "test",
            expiresAt: "2025-01-01T01:00:00Z",
            sessionId: "test-1",
          },
        ]),
      );

      const state = await StateManager.load(tmpDir);
      const sessions = state.getSessions();
      expect(sessions["test-1"]).toBeDefined();
      expect(sessions["test-1"].status).toBe("running");
      expect(state.getLocks()).toHaveLength(1);
      expect(state.getFuses()).toHaveLength(1);
    });
  });

  describe("persist", () => {
    it("writes state to files atomically", async () => {
      const state = await StateManager.load(tmpDir);
      state.setSession("s1", {
        id: "s1",
        adapter: "claude-code",
        status: "running",
        startedAt: "2025-01-01T00:00:00Z",
        meta: {},
      });
      state.addLock({
        directory: "/tmp/test",
        type: "manual",
        lockedBy: "user",
        lockedAt: "2025-01-01T00:00:00Z",
      });

      // Flush timer and persist manually
      state.flush();
      await state.persist();

      // Verify files
      const stateRaw = await fs.readFile(
        path.join(tmpDir, "state.json"),
        "utf-8",
      );
      const stateData = JSON.parse(stateRaw);
      expect(stateData.sessions.s1.status).toBe("running");
      expect(stateData.version).toBe(1);

      const locksRaw = await fs.readFile(
        path.join(tmpDir, "locks.json"),
        "utf-8",
      );
      const locksData = JSON.parse(locksRaw);
      expect(locksData).toHaveLength(1);
      expect(locksData[0].directory).toBe("/tmp/test");
    });

    it("survives round-trip load → mutate → persist → reload", async () => {
      const state1 = await StateManager.load(tmpDir);
      state1.setSession("s1", {
        id: "s1",
        adapter: "test",
        status: "running",
        startedAt: "2025-01-01T00:00:00Z",
        meta: { key: "value" },
      });
      state1.flush();
      await state1.persist();

      const state2 = await StateManager.load(tmpDir);
      const session = state2.getSession("s1");
      expect(session).toBeDefined();
      expect(session?.meta.key).toBe("value");
    });
  });

  describe("sessions", () => {
    it("get/set/remove sessions", async () => {
      const state = await StateManager.load(tmpDir);

      state.setSession("s1", {
        id: "s1",
        adapter: "test",
        status: "running",
        startedAt: new Date().toISOString(),
        meta: {},
      });

      expect(state.getSession("s1")).toBeDefined();
      expect(state.getSession("s2")).toBeUndefined();

      state.removeSession("s1");
      expect(state.getSession("s1")).toBeUndefined();
    });
  });

  describe("locks", () => {
    it("add and remove locks", async () => {
      const state = await StateManager.load(tmpDir);

      const lock: Lock = {
        directory: "/tmp/a",
        type: "auto",
        sessionId: "s1",
        lockedAt: new Date().toISOString(),
      };
      state.addLock(lock);
      expect(state.getLocks()).toHaveLength(1);

      state.removeLocks((l) => l.sessionId === "s1");
      expect(state.getLocks()).toHaveLength(0);
    });

    it("getLocks returns a copy", async () => {
      const state = await StateManager.load(tmpDir);
      const locks = state.getLocks();
      locks.push({
        directory: "/tmp",
        type: "manual",
        lockedAt: new Date().toISOString(),
      });
      // Original should not be modified
      expect(state.getLocks()).toHaveLength(0);
    });
  });

  describe("fuses", () => {
    it("add and remove fuses", async () => {
      const state = await StateManager.load(tmpDir);

      const fuse: FuseTimer = {
        directory: "/tmp/mono-test",
        clusterName: "kindo-charlie-test",
        branch: "test",
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        sessionId: "s1",
      };
      state.addFuse(fuse);
      expect(state.getFuses()).toHaveLength(1);

      state.removeFuse("/tmp/mono-test");
      expect(state.getFuses()).toHaveLength(0);
    });

    it("adding fuse for same directory replaces existing", async () => {
      const state = await StateManager.load(tmpDir);

      state.addFuse({
        directory: "/tmp/mono-test",
        clusterName: "cluster-1",
        branch: "test",
        expiresAt: new Date().toISOString(),
        sessionId: "s1",
      });
      state.addFuse({
        directory: "/tmp/mono-test",
        clusterName: "cluster-2",
        branch: "test",
        expiresAt: new Date().toISOString(),
        sessionId: "s2",
      });

      const fuses = state.getFuses();
      expect(fuses).toHaveLength(1);
      expect(fuses[0].clusterName).toBe("cluster-2");
    });
  });
});
