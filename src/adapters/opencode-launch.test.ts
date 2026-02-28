import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Track spawn calls
const spawnCalls: { cmd: string; args: string[] }[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return {
    ...orig,
    spawn: (cmd: string, args: string[], _opts: unknown) => {
      spawnCalls.push({ cmd, args: [...args] });
      const child = new EventEmitter();
      Object.assign(child, {
        pid: 99999,
        unref: () => {},
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      return child;
    },
  };
});

vi.mock("../utils/resolve-binary.js", () => ({
  resolveBinaryPath: async () => "/usr/local/bin/opencode",
}));

// Import after mocks are declared (vitest hoists vi.mock)
const { OpenCodeAdapter } = await import("./opencode.js");

let tmpDir: string;
let adapter: InstanceType<typeof OpenCodeAdapter>;

beforeEach(async () => {
  spawnCalls.length = 0;
  tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentctl-opencode-launch-"),
  );
  const storageDir = path.join(tmpDir, "storage");
  const sessionsMetaDir = path.join(tmpDir, "opencode-sessions");
  await fs.mkdir(path.join(storageDir, "session"), { recursive: true });
  await fs.mkdir(sessionsMetaDir, { recursive: true });

  adapter = new OpenCodeAdapter({
    storageDir,
    sessionsMetaDir,
    getPids: async () => new Map(),
    isProcessAlive: () => false,
  });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("OpenCodeAdapter launch", () => {
  it("passes --model flag when opts.model is set", async () => {
    await adapter.launch({
      adapter: "opencode",
      prompt: "fix the bug",
      model: "deepseek-r1",
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args;
    expect(args).toContain("--model");
    expect(args).toContain("deepseek-r1");
    // --model and its value should appear before the prompt
    const modelIdx = args.indexOf("--model");
    const promptIdx = args.indexOf("fix the bug");
    expect(modelIdx).toBeLessThan(promptIdx);
    expect(args).toEqual(["run", "--model", "deepseek-r1", "fix the bug"]);
  });

  it("omits --model flag when opts.model is not set", async () => {
    await adapter.launch({
      adapter: "opencode",
      prompt: "fix the bug",
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args;
    expect(args).not.toContain("--model");
    expect(args).toEqual(["run", "fix the bug"]);
  });
});
