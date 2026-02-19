import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockManager } from "./lock-manager.js";
import { StateManager } from "./state.js";

let tmpDir: string;
let state: StateManager;
let lockManager: LockManager;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-lock-test-"));
  state = await StateManager.load(tmpDir);
  lockManager = new LockManager(state);
});

afterEach(async () => {
  state.flush();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("LockManager", () => {
  describe("check", () => {
    it("returns null for unlocked directory", () => {
      expect(lockManager.check("/tmp/free-dir")).toBeNull();
    });

    it("returns auto lock if directory is auto-locked", () => {
      lockManager.autoLock("/tmp/locked", "session-1");
      const lock = lockManager.check("/tmp/locked");
      expect(lock).toBeDefined();
      expect(lock?.type).toBe("auto");
      expect(lock?.sessionId).toBe("session-1");
    });

    it("returns manual lock with precedence over auto lock", () => {
      lockManager.autoLock("/tmp/locked", "session-1");
      lockManager.manualLock("/tmp/locked", "user", "testing");
      const lock = lockManager.check("/tmp/locked");
      expect(lock).toBeDefined();
      expect(lock?.type).toBe("manual");
      expect(lock?.lockedBy).toBe("user");
    });
  });

  describe("autoLock", () => {
    it("creates auto lock for directory", () => {
      const lock = lockManager.autoLock("/tmp/dir", "s1");
      expect(lock.type).toBe("auto");
      expect(lock.directory).toBe("/tmp/dir");
      expect(lock.sessionId).toBe("s1");
    });

    it("is idempotent for same session", () => {
      lockManager.autoLock("/tmp/dir", "s1");
      lockManager.autoLock("/tmp/dir", "s1");
      const locks = lockManager.listAll();
      const autoLocks = locks.filter(
        (l) => l.directory === "/tmp/dir" && l.type === "auto",
      );
      expect(autoLocks).toHaveLength(1);
    });

    it("allows multiple auto-locks for same dir by different sessions", () => {
      lockManager.autoLock("/tmp/dir", "s1");
      lockManager.autoLock("/tmp/dir", "s2");
      const locks = lockManager.listAll();
      const autoLocks = locks.filter(
        (l) => l.directory === "/tmp/dir" && l.type === "auto",
      );
      expect(autoLocks).toHaveLength(2);
    });
  });

  describe("autoUnlock", () => {
    it("removes auto lock for session", () => {
      lockManager.autoLock("/tmp/dir1", "s1");
      lockManager.autoLock("/tmp/dir2", "s1");
      lockManager.autoUnlock("s1");
      expect(lockManager.listAll()).toHaveLength(0);
    });

    it("does not remove locks for other sessions", () => {
      lockManager.autoLock("/tmp/dir", "s1");
      lockManager.autoLock("/tmp/dir", "s2");
      lockManager.autoUnlock("s1");
      const locks = lockManager.listAll();
      expect(locks).toHaveLength(1);
      expect(locks[0].sessionId).toBe("s2");
    });
  });

  describe("manualLock", () => {
    it("creates manual lock", () => {
      const lock = lockManager.manualLock("/tmp/dir", "user", "reason");
      expect(lock.type).toBe("manual");
      expect(lock.lockedBy).toBe("user");
      expect(lock.reason).toBe("reason");
    });

    it("throws if already manually locked", () => {
      lockManager.manualLock("/tmp/dir", "user1", "first");
      expect(() =>
        lockManager.manualLock("/tmp/dir", "user2", "second"),
      ).toThrow("Already manually locked");
    });

    it("allows manual lock over auto-lock", () => {
      lockManager.autoLock("/tmp/dir", "s1");
      const lock = lockManager.manualLock("/tmp/dir", "user", "override");
      expect(lock.type).toBe("manual");
    });
  });

  describe("manualUnlock", () => {
    it("removes manual lock", () => {
      lockManager.manualLock("/tmp/dir", "user");
      lockManager.manualUnlock("/tmp/dir");
      expect(lockManager.check("/tmp/dir")).toBeNull();
    });

    it("throws if no manual lock exists", () => {
      expect(() => lockManager.manualUnlock("/tmp/dir")).toThrow(
        "No manual lock",
      );
    });

    it("does not remove auto locks", () => {
      lockManager.autoLock("/tmp/dir", "s1");
      expect(() => lockManager.manualUnlock("/tmp/dir")).toThrow(
        "No manual lock",
      );
      expect(lockManager.listAll()).toHaveLength(1);
    });
  });

  describe("listAll", () => {
    it("returns all locks", () => {
      lockManager.autoLock("/tmp/a", "s1");
      lockManager.manualLock("/tmp/b", "user", "reason");
      expect(lockManager.listAll()).toHaveLength(2);
    });
  });
});
