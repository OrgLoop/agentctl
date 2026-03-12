import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupExpiredMeta,
  deleteSessionMeta,
  readSessionMeta,
  writeSessionMeta,
} from "./session-meta.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-meta-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("session-meta", () => {
  describe("writeSessionMeta + readSessionMeta", () => {
    it("writes and reads minimal metadata", async () => {
      await writeSessionMeta(tmpDir, { sessionId: "s1", pid: 12345 });
      const meta = await readSessionMeta(tmpDir, "s1");
      expect(meta).toBeDefined();
      expect(meta?.sessionId).toBe("s1");
      expect(meta?.pid).toBe(12345);
      expect(meta?.launchedAt).toBeDefined();
    });

    it("returns null for non-existent session", async () => {
      const meta = await readSessionMeta(tmpDir, "nonexistent");
      expect(meta).toBeNull();
    });

    it("returns null for non-existent directory", async () => {
      const meta = await readSessionMeta("/tmp/does-not-exist-meta", "s1");
      expect(meta).toBeNull();
    });
  });

  describe("TTL expiry", () => {
    it("returns null for expired metadata (>24h)", async () => {
      // Write a meta file with a launchedAt over 24 hours ago
      const metaPath = path.join(tmpDir, "old-session.json");
      const oldMeta = {
        sessionId: "old-session",
        pid: 99999,
        launchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      };
      await fs.writeFile(metaPath, JSON.stringify(oldMeta));

      const meta = await readSessionMeta(tmpDir, "old-session");
      expect(meta).toBeNull();
    });

    it("deletes expired file on read", async () => {
      const metaPath = path.join(tmpDir, "old-session.json");
      const oldMeta = {
        sessionId: "old-session",
        pid: 99999,
        launchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      };
      await fs.writeFile(metaPath, JSON.stringify(oldMeta));

      await readSessionMeta(tmpDir, "old-session");

      // File should be cleaned up
      await expect(fs.access(metaPath)).rejects.toThrow();
    });

    it("returns recent metadata (within 24h)", async () => {
      await writeSessionMeta(tmpDir, { sessionId: "fresh", pid: 11111 });
      const meta = await readSessionMeta(tmpDir, "fresh");
      expect(meta).toBeDefined();
      expect(meta?.sessionId).toBe("fresh");
    });
  });

  describe("deleteSessionMeta", () => {
    it("deletes a metadata file", async () => {
      await writeSessionMeta(tmpDir, { sessionId: "s1", pid: 12345 });
      await deleteSessionMeta(tmpDir, "s1");
      const meta = await readSessionMeta(tmpDir, "s1");
      expect(meta).toBeNull();
    });

    it("does not throw for non-existent file", async () => {
      await expect(
        deleteSessionMeta(tmpDir, "nonexistent"),
      ).resolves.not.toThrow();
    });
  });

  describe("cleanupExpiredMeta", () => {
    it("removes expired files and keeps fresh ones", async () => {
      // Write a fresh meta
      await writeSessionMeta(tmpDir, { sessionId: "fresh", pid: 11111 });

      // Write an expired meta
      const oldPath = path.join(tmpDir, "old.json");
      await fs.writeFile(
        oldPath,
        JSON.stringify({
          sessionId: "old",
          pid: 22222,
          launchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        }),
      );

      const cleaned = await cleanupExpiredMeta(tmpDir);
      expect(cleaned).toBe(1);

      // Fresh file should still exist
      const freshMeta = await readSessionMeta(tmpDir, "fresh");
      expect(freshMeta).toBeDefined();

      // Old file should be gone
      await expect(fs.access(oldPath)).rejects.toThrow();
    });

    it("returns 0 for empty directory", async () => {
      const cleaned = await cleanupExpiredMeta(tmpDir);
      expect(cleaned).toBe(0);
    });

    it("returns 0 for non-existent directory", async () => {
      const cleaned = await cleanupExpiredMeta("/tmp/does-not-exist-cleanup");
      expect(cleaned).toBe(0);
    });
  });
});
