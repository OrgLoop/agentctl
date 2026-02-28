import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseProviderModel } from "./pi-rust.js";

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
        pid: 88888,
        unref: () => {},
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        fd: 1,
      });
      return child;
    },
  };
});

vi.mock("../utils/resolve-binary.js", () => ({
  resolveBinaryPath: async () => "/usr/local/bin/pi-rust",
}));

// Import after mocks are declared (vitest hoists vi.mock)
const { PiRustAdapter } = await import("./pi-rust.js");

let tmpDir: string;
let adapter: InstanceType<typeof PiRustAdapter>;

beforeEach(async () => {
  spawnCalls.length = 0;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-pi-rust-launch-"));
  const sessionDir = path.join(tmpDir, "sessions");
  const sessionsMetaDir = path.join(tmpDir, "agentctl-meta");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(sessionsMetaDir, { recursive: true });

  adapter = new PiRustAdapter({
    sessionDir,
    sessionsMetaDir,
    getPids: async () => new Map(),
    isProcessAlive: () => false,
  });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("parseProviderModel", () => {
  it("splits provider/model on first slash", () => {
    expect(parseProviderModel("togetherai/meta-llama/Llama-3-70B")).toEqual({
      provider: "togetherai",
      model: "meta-llama/Llama-3-70B",
    });
  });

  it("returns undefined provider for plain model", () => {
    expect(parseProviderModel("claude-opus-4-6")).toEqual({
      provider: undefined,
      model: "claude-opus-4-6",
    });
  });

  it("uses explicit provider and strips matching prefix", () => {
    expect(parseProviderModel("togetherai/some-model", "togetherai")).toEqual({
      provider: "togetherai",
      model: "some-model",
    });
  });

  it("uses explicit provider without stripping non-matching prefix", () => {
    expect(parseProviderModel("some-model", "openrouter")).toEqual({
      provider: "openrouter",
      model: "some-model",
    });
  });
});

describe("PiRustAdapter launch", () => {
  it("parses provider from model string prefix", async () => {
    await adapter.launch({
      adapter: "pi-rust",
      prompt: "fix the bug",
      model: "togetherai/meta-llama/Llama-3-70B",
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args;
    expect(args).toContain("--provider");
    expect(args).toContain("togetherai");
    expect(args).toContain("--model");
    expect(args).toContain("meta-llama/Llama-3-70B");
    // provider should come before model
    expect(args.indexOf("--provider")).toBeLessThan(args.indexOf("--model"));
  });

  it("accepts provider via adapterOpts", async () => {
    await adapter.launch({
      adapter: "pi-rust",
      prompt: "fix the bug",
      model: "some-model",
      adapterOpts: { provider: "openrouter" },
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args;
    expect(args).toContain("--provider");
    expect(args).toContain("openrouter");
    expect(args).toContain("--model");
    expect(args).toContain("some-model");
  });

  it("passes --append-system-prompt from launch opts", async () => {
    await adapter.launch({
      adapter: "pi-rust",
      prompt: "fix the bug",
      appendSystemPrompt: "Always use TypeScript",
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args;
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("Always use TypeScript");
  });

  it("passes --append-system-prompt from adapterOpts", async () => {
    await adapter.launch({
      adapter: "pi-rust",
      prompt: "fix the bug",
      adapterOpts: { appendSystemPrompt: "Use bun" },
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args;
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("Use bun");
  });

  it("omits --provider when model has no slash prefix", async () => {
    await adapter.launch({
      adapter: "pi-rust",
      prompt: "fix the bug",
      model: "claude-opus-4-6",
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args;
    expect(args).not.toContain("--provider");
    expect(args).toContain("--model");
    expect(args).toContain("claude-opus-4-6");
  });

  it("passes provider from adapterOpts even without model", async () => {
    await adapter.launch({
      adapter: "pi-rust",
      prompt: "fix the bug",
      adapterOpts: { provider: "openrouter" },
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args;
    expect(args).toContain("--provider");
    expect(args).toContain("openrouter");
  });
});
