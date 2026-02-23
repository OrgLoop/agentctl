import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LifecycleHooks } from "./core/types.js";
import { type HookContext, runHook } from "./hooks.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-hooks-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const defaultCtx: HookContext = {
  sessionId: "test-session-123",
  cwd: "/tmp",
  adapter: "claude-code",
};

describe("runHook", () => {
  it("returns null when hooks are undefined", async () => {
    const result = await runHook(undefined, "onCreate", defaultCtx);
    expect(result).toBeNull();
  });

  it("returns null when specific hook is not defined", async () => {
    const hooks: LifecycleHooks = { onComplete: "echo done" };
    const result = await runHook(hooks, "onCreate", defaultCtx);
    expect(result).toBeNull();
  });

  it("runs onCreate hook", async () => {
    const hooks: LifecycleHooks = { onCreate: "echo hello" };
    const result = await runHook(hooks, "onCreate", {
      ...defaultCtx,
      cwd: tmpDir,
    });
    expect(result).not.toBeNull();
    expect(result?.stdout.trim()).toBe("hello");
  });

  it("passes environment variables to hook", async () => {
    const hooks: LifecycleHooks = {
      onCreate: "echo $AGENTCTL_SESSION_ID $AGENTCTL_ADAPTER",
    };
    const result = await runHook(hooks, "onCreate", {
      ...defaultCtx,
      cwd: tmpDir,
    });
    expect(result?.stdout.trim()).toBe("test-session-123 claude-code");
  });

  it("passes branch via env var", async () => {
    const hooks: LifecycleHooks = { onCreate: "echo $AGENTCTL_BRANCH" };
    const result = await runHook(hooks, "onCreate", {
      ...defaultCtx,
      cwd: tmpDir,
      branch: "feature/test",
    });
    expect(result?.stdout.trim()).toBe("feature/test");
  });

  it("passes exit code via env var", async () => {
    const hooks: LifecycleHooks = { onComplete: "echo $AGENTCTL_EXIT_CODE" };
    const result = await runHook(hooks, "onComplete", {
      ...defaultCtx,
      cwd: tmpDir,
      exitCode: 0,
    });
    expect(result?.stdout.trim()).toBe("0");
  });

  it("passes group via env var", async () => {
    const hooks: LifecycleHooks = { onCreate: "echo $AGENTCTL_GROUP" };
    const result = await runHook(hooks, "onCreate", {
      ...defaultCtx,
      cwd: tmpDir,
      group: "g-abc123",
    });
    expect(result?.stdout.trim()).toBe("g-abc123");
  });

  it("passes model via env var", async () => {
    const hooks: LifecycleHooks = { onCreate: "echo $AGENTCTL_MODEL" };
    const result = await runHook(hooks, "onCreate", {
      ...defaultCtx,
      cwd: tmpDir,
      model: "claude-opus-4-6",
    });
    expect(result?.stdout.trim()).toBe("claude-opus-4-6");
  });

  it("handles hook script failures gracefully", async () => {
    const hooks: LifecycleHooks = { onCreate: "exit 1" };
    const result = await runHook(hooks, "onCreate", {
      ...defaultCtx,
      cwd: tmpDir,
    });
    // Should not throw, returns result with stderr
    expect(result).not.toBeNull();
  });

  it("runs onComplete hook", async () => {
    const outFile = path.join(tmpDir, "hook-output.txt");
    const hooks: LifecycleHooks = {
      onComplete: `echo completed > ${outFile}`,
    };
    await runHook(hooks, "onComplete", { ...defaultCtx, cwd: tmpDir });
    const content = await fs.readFile(outFile, "utf-8");
    expect(content.trim()).toBe("completed");
  });
});
