import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LARGE_PROMPT_THRESHOLD } from "../utils/prompt-file.js";

// Track spawn calls including stdio configuration
const spawnCalls: {
  cmd: string;
  args: string[];
  opts: { stdio: unknown[] };
}[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return {
    ...orig,
    spawn: (
      cmd: string,
      args: string[],
      opts: { stdio: unknown[]; [key: string]: unknown },
    ) => {
      spawnCalls.push({
        cmd,
        args: [...args],
        opts: { stdio: [...opts.stdio] },
      });
      const child = new EventEmitter();
      Object.assign(child, {
        pid: 77777,
        unref: () => {},
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      return child;
    },
  };
});

vi.mock("../utils/resolve-binary.js", () => ({
  resolveBinaryPath: async (name: string) => `/usr/local/bin/${name}`,
}));

// Import after mocks are declared (vitest hoists vi.mock)
const { OpenCodeAdapter } = await import("./opencode.js");
const { ClaudeCodeAdapter } = await import("./claude-code.js");
const { CodexAdapter } = await import("./codex.js");
const { PiAdapter } = await import("./pi.js");
const { PiRustAdapter } = await import("./pi-rust.js");

let tmpDir: string;

beforeEach(async () => {
  spawnCalls.length = 0;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-large-prompt-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const smallPrompt = "Fix the bug";
const largePrompt = "X".repeat(LARGE_PROMPT_THRESHOLD + 1);

describe("Large prompt handling — OpenCode", () => {
  let adapter: InstanceType<typeof OpenCodeAdapter>;

  beforeEach(async () => {
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

  it("passes small prompt as CLI arg", async () => {
    await adapter.launch({
      adapter: "opencode",
      prompt: smallPrompt,
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toContain(smallPrompt);
    // stdin should be "ignore" for small prompts
    expect(spawnCalls[0].opts.stdio[0]).toBe("ignore");
  });

  it("pipes large prompt via stdin instead of CLI arg", async () => {
    await adapter.launch({
      adapter: "opencode",
      prompt: largePrompt,
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    // Large prompt must NOT appear in args
    expect(spawnCalls[0].args).not.toContain(largePrompt);
    expect(spawnCalls[0].args).toEqual(["run"]);
    // stdin should be a file descriptor (number), not "ignore"
    expect(typeof spawnCalls[0].opts.stdio[0]).toBe("number");
  });
});

describe("Large prompt handling — Claude Code", () => {
  let adapter: InstanceType<typeof ClaudeCodeAdapter>;

  beforeEach(async () => {
    const claudeDir = path.join(tmpDir, ".claude");
    const sessionsMetaDir = path.join(claudeDir, "agentctl", "sessions");
    await fs.mkdir(path.join(claudeDir, "projects"), { recursive: true });
    await fs.mkdir(sessionsMetaDir, { recursive: true });

    adapter = new ClaudeCodeAdapter({
      claudeDir,
      sessionsMetaDir,
      getPids: async () => new Map(),
      isProcessAlive: () => false,
    });
  });

  it("passes small prompt via -p flag", async () => {
    await adapter.launch({
      adapter: "claude-code",
      prompt: smallPrompt,
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args;
    expect(args).toContain("-p");
    expect(args).toContain(smallPrompt);
    expect(spawnCalls[0].opts.stdio[0]).toBe("ignore");
  });

  it("pipes large prompt via stdin, omits -p flag", async () => {
    await adapter.launch({
      adapter: "claude-code",
      prompt: largePrompt,
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args;
    // -p flag must NOT be present
    expect(args).not.toContain("-p");
    expect(args).not.toContain(largePrompt);
    // stdin should be a file descriptor
    expect(typeof spawnCalls[0].opts.stdio[0]).toBe("number");
  });
});

describe("Large prompt handling — Codex", () => {
  let adapter: InstanceType<typeof CodexAdapter>;

  beforeEach(async () => {
    const codexDir = path.join(tmpDir, ".codex");
    const sessionsMetaDir = path.join(codexDir, "agentctl", "sessions");
    await fs.mkdir(path.join(codexDir, "sessions"), { recursive: true });
    await fs.mkdir(sessionsMetaDir, { recursive: true });

    adapter = new CodexAdapter({
      codexDir,
      sessionsMetaDir,
      getPids: async () => new Map(),
      isProcessAlive: () => false,
    });
  });

  it("passes small prompt as CLI arg", async () => {
    await adapter.launch({
      adapter: "codex",
      prompt: smallPrompt,
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toContain(smallPrompt);
    expect(spawnCalls[0].opts.stdio[0]).toBe("ignore");
  });

  it("pipes large prompt via stdin instead of CLI arg", async () => {
    await adapter.launch({
      adapter: "codex",
      prompt: largePrompt,
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).not.toContain(largePrompt);
    expect(typeof spawnCalls[0].opts.stdio[0]).toBe("number");
  });
});

describe("Large prompt handling — Pi", () => {
  let adapter: InstanceType<typeof PiAdapter>;

  beforeEach(async () => {
    const piDir = path.join(tmpDir, ".pi");
    const sessionsMetaDir = path.join(piDir, "agentctl", "sessions");
    await fs.mkdir(path.join(piDir, "agent", "sessions"), { recursive: true });
    await fs.mkdir(sessionsMetaDir, { recursive: true });

    adapter = new PiAdapter({
      piDir,
      sessionsMetaDir,
      getPids: async () => new Map(),
      isProcessAlive: () => false,
    });
  });

  it("passes small prompt via -p flag", async () => {
    await adapter.launch({
      adapter: "pi",
      prompt: smallPrompt,
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args;
    expect(args).toContain("-p");
    expect(args).toContain(smallPrompt);
    expect(spawnCalls[0].opts.stdio[0]).toBe("ignore");
  });

  it("pipes large prompt via stdin, omits -p flag", async () => {
    await adapter.launch({
      adapter: "pi",
      prompt: largePrompt,
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args;
    expect(args).not.toContain("-p");
    expect(args).not.toContain(largePrompt);
    // Should still have --mode json
    expect(args).toContain("--mode");
    expect(args).toContain("json");
    expect(typeof spawnCalls[0].opts.stdio[0]).toBe("number");
  });
});

describe("Large prompt handling — Pi Rust", () => {
  let adapter: InstanceType<typeof PiRustAdapter>;

  beforeEach(async () => {
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

  it("passes small prompt as positional arg", async () => {
    await adapter.launch({
      adapter: "pi-rust",
      prompt: smallPrompt,
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toContain(smallPrompt);
    expect(spawnCalls[0].opts.stdio[0]).toBe("ignore");
  });

  it("pipes large prompt via stdin instead of positional arg", async () => {
    await adapter.launch({
      adapter: "pi-rust",
      prompt: largePrompt,
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args;
    expect(args).not.toContain(largePrompt);
    // Should still have --print --mode json
    expect(args).toContain("--print");
    expect(args).toContain("--mode");
    expect(args).toContain("json");
    expect(typeof spawnCalls[0].opts.stdio[0]).toBe("number");
  });

  it("preserves --model and --provider with large prompts", async () => {
    await adapter.launch({
      adapter: "pi-rust",
      prompt: largePrompt,
      model: "togetherai/meta-llama/Llama-3-70B",
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args;
    expect(args).toContain("--provider");
    expect(args).toContain("togetherai");
    expect(args).toContain("--model");
    expect(args).toContain("meta-llama/Llama-3-70B");
    expect(args).not.toContain(largePrompt);
    expect(typeof spawnCalls[0].opts.stdio[0]).toBe("number");
  });
});
