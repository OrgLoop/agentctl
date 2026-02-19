import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FuseEngine } from "./fuse-engine.js";
import type { SessionRecord } from "./state.js";
import { StateManager } from "./state.js";

let tmpDir: string;
let state: StateManager;
let fuseEngine: FuseEngine;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-fuse-test-"));
  state = await StateManager.load(tmpDir);
  fuseEngine = new FuseEngine(state, { defaultDurationMs: 10 * 60 * 1000 });
});

afterEach(async () => {
  fuseEngine.shutdown();
  state.flush();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("FuseEngine", () => {
  describe("deriveClusterName", () => {
    it("derives cluster name from mono worktree path", () => {
      const home = os.homedir();
      const result = FuseEngine.deriveClusterName(
        path.join(home, "code", "mono-feature-x"),
      );
      expect(result).toEqual({
        clusterName: "kindo-charlie-feature-x",
        branch: "feature-x",
      });
    });

    it("returns null for non-mono directory", () => {
      const result = FuseEngine.deriveClusterName("/tmp/random-project");
      expect(result).toBeNull();
    });

    it("returns null for mono base directory without branch", () => {
      const home = os.homedir();
      const result = FuseEngine.deriveClusterName(
        path.join(home, "code", "mono-"),
      );
      expect(result).toBeNull();
    });

    it("handles nested branch names", () => {
      const home = os.homedir();
      // Note: path.join normalizes slashes. Using the full path:
      const dir = `${home}/code/mono-fix/auth-bug`;
      const result = FuseEngine.deriveClusterName(dir);
      expect(result).toEqual({
        clusterName: "kindo-charlie-fix/auth-bug",
        branch: "fix/auth-bug",
      });
    });
  });

  describe("onSessionExit", () => {
    it("starts fuse for mono worktree session", () => {
      const home = os.homedir();
      const session: SessionRecord = {
        id: "s1",
        adapter: "claude-code",
        status: "stopped",
        startedAt: new Date().toISOString(),
        cwd: path.join(home, "code", "mono-feature-x"),
        meta: {},
      };

      fuseEngine.onSessionExit(session);
      const fuses = fuseEngine.listActive();
      expect(fuses).toHaveLength(1);
      expect(fuses[0].clusterName).toBe("kindo-charlie-feature-x");
      expect(fuses[0].branch).toBe("feature-x");
    });

    it("does not start fuse for non-mono session", () => {
      const session: SessionRecord = {
        id: "s1",
        adapter: "claude-code",
        status: "stopped",
        startedAt: new Date().toISOString(),
        cwd: "/tmp/random-project",
        meta: {},
      };

      fuseEngine.onSessionExit(session);
      expect(fuseEngine.listActive()).toHaveLength(0);
    });

    it("does not start fuse for session without cwd", () => {
      const session: SessionRecord = {
        id: "s1",
        adapter: "claude-code",
        status: "stopped",
        startedAt: new Date().toISOString(),
        meta: {},
      };

      fuseEngine.onSessionExit(session);
      expect(fuseEngine.listActive()).toHaveLength(0);
    });
  });

  describe("cancelFuse", () => {
    it("cancels an active fuse", () => {
      const home = os.homedir();
      const dir = path.join(home, "code", "mono-feature-x");

      fuseEngine.onSessionExit({
        id: "s1",
        adapter: "test",
        status: "stopped",
        startedAt: new Date().toISOString(),
        cwd: dir,
        meta: {},
      });

      expect(fuseEngine.listActive()).toHaveLength(1);
      const cancelled = fuseEngine.cancelFuse(dir);
      expect(cancelled).toBe(true);
      expect(fuseEngine.listActive()).toHaveLength(0);
    });

    it("returns false when no fuse exists", () => {
      const cancelled = fuseEngine.cancelFuse("/tmp/no-fuse");
      expect(cancelled).toBe(false);
    });
  });

  describe("resumeTimers", () => {
    it("resumes fuses from persisted state", async () => {
      const home = os.homedir();
      const dir = path.join(home, "code", "mono-feature-x");

      // Add fuse directly to state (simulating loaded state)
      state.addFuse({
        directory: dir,
        clusterName: "kindo-charlie-feature-x",
        branch: "feature-x",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        sessionId: "s1",
      });

      // Create fresh engine and resume
      const engine2 = new FuseEngine(state, {
        defaultDurationMs: 10 * 60 * 1000,
      });
      engine2.resumeTimers();
      expect(engine2.listActive()).toHaveLength(1);
      engine2.shutdown();
    });
  });

  describe("listActive", () => {
    it("returns empty list when no fuses", () => {
      expect(fuseEngine.listActive()).toHaveLength(0);
    });
  });
});
