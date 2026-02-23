import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FuseEngine } from "./fuse-engine.js";
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
  describe("setFuse", () => {
    it("sets a fuse for a directory", () => {
      fuseEngine.setFuse({
        directory: "/tmp/project-a",
        sessionId: "s1",
      });

      const fuses = fuseEngine.listActive();
      expect(fuses).toHaveLength(1);
      expect(fuses[0].directory).toBe("/tmp/project-a");
      expect(fuses[0].sessionId).toBe("s1");
      expect(fuses[0].ttlMs).toBe(10 * 60 * 1000);
    });

    it("uses custom TTL when provided", () => {
      fuseEngine.setFuse({
        directory: "/tmp/project-b",
        sessionId: "s1",
        ttlMs: 30_000,
      });

      const fuses = fuseEngine.listActive();
      expect(fuses[0].ttlMs).toBe(30_000);
    });

    it("stores on-expire action", () => {
      fuseEngine.setFuse({
        directory: "/tmp/project-c",
        sessionId: "s1",
        onExpire: { script: "echo done", webhook: "https://example.com/hook" },
      });

      const fuses = fuseEngine.listActive();
      expect(fuses[0].onExpire?.script).toBe("echo done");
      expect(fuses[0].onExpire?.webhook).toBe("https://example.com/hook");
    });

    it("stores label", () => {
      fuseEngine.setFuse({
        directory: "/tmp/project-d",
        sessionId: "s1",
        label: "cleanup-worktree",
      });

      const fuses = fuseEngine.listActive();
      expect(fuses[0].label).toBe("cleanup-worktree");
    });

    it("replaces existing fuse for same directory", () => {
      fuseEngine.setFuse({
        directory: "/tmp/project-e",
        sessionId: "s1",
      });
      fuseEngine.setFuse({
        directory: "/tmp/project-e",
        sessionId: "s2",
      });

      const fuses = fuseEngine.listActive();
      expect(fuses).toHaveLength(1);
      expect(fuses[0].sessionId).toBe("s2");
    });

    it("emits fuse.set event", () => {
      const emitter = new EventEmitter();
      const handler = vi.fn();
      emitter.on("fuse.set", handler);

      const engine = new FuseEngine(state, {
        defaultDurationMs: 600_000,
        emitter,
      });
      engine.setFuse({ directory: "/tmp/test", sessionId: "s1" });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].directory).toBe("/tmp/test");
      engine.shutdown();
    });
  });

  describe("extendFuse", () => {
    it("extends an existing fuse", () => {
      fuseEngine.setFuse({
        directory: "/tmp/project-f",
        sessionId: "s1",
        ttlMs: 60_000,
      });

      const extended = fuseEngine.extendFuse("/tmp/project-f", 120_000);
      expect(extended).toBe(true);

      const fuses = fuseEngine.listActive();
      expect(fuses).toHaveLength(1);
      expect(fuses[0].ttlMs).toBe(120_000);
    });

    it("returns false when no fuse exists", () => {
      const extended = fuseEngine.extendFuse("/tmp/nonexistent");
      expect(extended).toBe(false);
    });

    it("emits fuse.extended event", () => {
      const emitter = new EventEmitter();
      const handler = vi.fn();
      emitter.on("fuse.extended", handler);

      const engine = new FuseEngine(state, {
        defaultDurationMs: 600_000,
        emitter,
      });
      engine.setFuse({ directory: "/tmp/test", sessionId: "s1" });
      engine.extendFuse("/tmp/test", 120_000);

      expect(handler).toHaveBeenCalledTimes(1);
      engine.shutdown();
    });
  });

  describe("cancelFuse", () => {
    it("cancels an active fuse", () => {
      fuseEngine.setFuse({
        directory: "/tmp/project-g",
        sessionId: "s1",
      });

      expect(fuseEngine.listActive()).toHaveLength(1);
      const cancelled = fuseEngine.cancelFuse("/tmp/project-g");
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
      // Add fuse directly to state (simulating loaded state)
      state.addFuse({
        directory: "/tmp/project-h",
        ttlMs: 300_000,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
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
