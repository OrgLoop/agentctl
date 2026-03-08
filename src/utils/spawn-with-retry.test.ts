import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process.spawn
const spawnCalls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
let spawnErrorToEmit: NodeJS.ErrnoException | null = null;
let spawnCallCount = 0;

vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
  return {
    spawn: (cmd: string, args: string[], opts: unknown) => {
      spawnCalls.push({ cmd, args: [...args], opts });
      spawnCallCount++;
      const child = new EventEmitter();
      child.pid = 12345;
      child.unref = vi.fn();

      // Emit error on the first call if configured
      if (spawnErrorToEmit && spawnCallCount === 1) {
        const err = spawnErrorToEmit;
        setImmediate(() => child.emit("error", err));
      }

      return child;
    },
  };
});

// Mock resolve-binary
let resolveCallCount = 0;
vi.mock("./resolve-binary.js", () => ({
  resolveBinaryPath: async (name: string) => {
    resolveCallCount++;
    return `/usr/local/bin/${name}`;
  },
  clearBinaryCache: vi.fn(),
}));

import { clearBinaryCache } from "./resolve-binary.js";
import { spawnWithRetry } from "./spawn-with-retry.js";

beforeEach(() => {
  spawnCalls.length = 0;
  spawnCallCount = 0;
  spawnErrorToEmit = null;
  resolveCallCount = 0;
  vi.clearAllMocks();
});

describe("spawnWithRetry", () => {
  it("resolves with child on successful spawn", async () => {
    const child = await spawnWithRetry("claude", ["--print"], { cwd: "/tmp" });
    expect(child.pid).toBe(12345);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe("/usr/local/bin/claude");
  });

  it("retries once on ENOENT, clearing binary cache", async () => {
    const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    spawnErrorToEmit = err;

    const child = await spawnWithRetry("claude", ["--print"], { cwd: "/tmp" });

    // Should have spawned twice (original + retry)
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0].cmd).toBe("/usr/local/bin/claude");
    expect(spawnCalls[1].cmd).toBe("/usr/local/bin/claude");

    // Should have cleared the binary cache
    expect(clearBinaryCache).toHaveBeenCalledTimes(1);

    // Should have resolved binary path twice
    expect(resolveCallCount).toBe(2);

    expect(child.pid).toBe(12345);
  });

  it("does not retry on non-ENOENT errors", async () => {
    const err = new Error("EACCES") as NodeJS.ErrnoException;
    err.code = "EACCES";
    spawnErrorToEmit = err;

    const child = await spawnWithRetry("claude", ["--print"], { cwd: "/tmp" });

    // Should have spawned only once
    expect(spawnCalls).toHaveLength(1);
    expect(clearBinaryCache).not.toHaveBeenCalled();
    expect(child.pid).toBe(12345);
  });
});
