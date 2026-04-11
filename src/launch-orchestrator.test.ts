import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentAdapter } from "./core/types.js";
import {
  type AdapterSlot,
  branchName,
  generateGroupId,
  orchestrateLaunch,
  parseAdapterSlots,
  slotSuffix,
  uniqueSlotSuffixes,
} from "./launch-orchestrator.js";

describe("generateGroupId", () => {
  it("generates a g-prefixed hex string", () => {
    const id = generateGroupId();
    expect(id).toMatch(/^g-[a-f0-9]{6}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateGroupId()));
    // With 3 bytes of randomness, 100 IDs should all be unique
    expect(ids.size).toBe(100);
  });
});

describe("slotSuffix", () => {
  it("uses short adapter name for unique adapters", () => {
    const slots: AdapterSlot[] = [
      { adapter: "claude-code" },
      { adapter: "codex" },
    ];
    expect(slotSuffix(slots[0], slots)).toBe("cc");
    expect(slotSuffix(slots[1], slots)).toBe("codex");
  });

  it("disambiguates same adapter with different models", () => {
    const slots: AdapterSlot[] = [
      { adapter: "claude-code", model: "claude-opus-4-6" },
      { adapter: "claude-code", model: "claude-sonnet-4-5" },
      { adapter: "codex" },
    ];
    expect(slotSuffix(slots[0], slots)).toBe("cc-opus");
    expect(slotSuffix(slots[1], slots)).toBe("cc-sonnet");
    expect(slotSuffix(slots[2], slots)).toBe("codex");
  });

  it("uses 'default' when same adapter appears twice without models", () => {
    const slots: AdapterSlot[] = [
      { adapter: "claude-code" },
      { adapter: "claude-code" },
    ];
    expect(slotSuffix(slots[0], slots)).toBe("cc-default");
  });

  it("handles pi-rust adapter shortening", () => {
    const slots: AdapterSlot[] = [{ adapter: "pi-rust" }];
    expect(slotSuffix(slots[0], slots)).toBe("pi-rs");
  });

  it("handles GPT model names", () => {
    const slots: AdapterSlot[] = [
      { adapter: "codex", model: "gpt-5.2-codex" },
      { adapter: "codex", model: "gpt-4o" },
    ];
    expect(slotSuffix(slots[0], slots)).toBe("codex-gpt5-codex");
    expect(slotSuffix(slots[1], slots)).toBe("codex-gpt4-o");
  });
});

describe("uniqueSlotSuffixes", () => {
  it("returns unmodified suffixes when no collisions", () => {
    const slots: AdapterSlot[] = [
      { adapter: "claude-code", model: "claude-opus-4-6" },
      { adapter: "claude-code", model: "claude-sonnet-4-5" },
      { adapter: "codex" },
    ];
    expect(uniqueSlotSuffixes(slots)).toEqual([
      "cc-opus",
      "cc-sonnet",
      "codex",
    ]);
  });

  it("appends counter when model suffixes collide", () => {
    const slots: AdapterSlot[] = [
      { adapter: "opencode", model: "vendor1/qwen-72b-FP8" },
      { adapter: "opencode", model: "vendor2/llama-70b-FP8" },
    ];
    const suffixes = uniqueSlotSuffixes(slots);
    expect(suffixes[0]).not.toBe(suffixes[1]);
    expect(suffixes).toEqual(["opencode-fp8", "opencode-fp8-2"]);
  });

  it("handles three-way collisions", () => {
    const slots: AdapterSlot[] = [
      { adapter: "opencode", model: "a/FP8" },
      { adapter: "opencode", model: "b/FP8" },
      { adapter: "opencode", model: "c/FP8" },
    ];
    const suffixes = uniqueSlotSuffixes(slots);
    expect(new Set(suffixes).size).toBe(3);
    expect(suffixes).toEqual([
      "opencode-fp8",
      "opencode-fp8-2",
      "opencode-fp8-3",
    ]);
  });

  it("handles duplicate adapters without models", () => {
    const slots: AdapterSlot[] = [
      { adapter: "claude-code" },
      { adapter: "claude-code" },
    ];
    const suffixes = uniqueSlotSuffixes(slots);
    expect(suffixes).toEqual(["cc-default", "cc-default-2"]);
  });
});

describe("branchName", () => {
  it("generates try/<groupId>/<suffix> format", () => {
    expect(branchName("g-abc123", "cc")).toBe("try/g-abc123/cc");
    expect(branchName("g-abc123", "cc-opus")).toBe("try/g-abc123/cc-opus");
  });
});

describe("parseAdapterSlots", () => {
  it("parses single --adapter", () => {
    const slots = parseAdapterSlots(["--adapter", "claude-code"]);
    expect(slots).toEqual([{ adapter: "claude-code" }]);
  });

  it("parses multiple --adapter flags", () => {
    const slots = parseAdapterSlots([
      "--adapter",
      "claude-code",
      "--adapter",
      "codex",
      "--adapter",
      "pi",
    ]);
    expect(slots).toEqual([
      { adapter: "claude-code" },
      { adapter: "codex" },
      { adapter: "pi" },
    ]);
  });

  it("parses --adapter with --model", () => {
    const slots = parseAdapterSlots([
      "--adapter",
      "claude-code",
      "--model",
      "claude-opus-4-6",
      "--adapter",
      "claude-code",
      "--model",
      "claude-sonnet-4-5",
    ]);
    expect(slots).toEqual([
      { adapter: "claude-code", model: "claude-opus-4-6" },
      { adapter: "claude-code", model: "claude-sonnet-4-5" },
    ]);
  });

  it("handles mixed with and without models", () => {
    const slots = parseAdapterSlots([
      "--adapter",
      "claude-code",
      "--model",
      "opus",
      "--adapter",
      "codex",
      "-p",
      "some prompt",
    ]);
    expect(slots).toEqual([
      { adapter: "claude-code", model: "opus" },
      { adapter: "codex" },
    ]);
  });

  it("ignores non-adapter/model flags", () => {
    const slots = parseAdapterSlots([
      "launch",
      "--adapter",
      "claude-code",
      "-p",
      "do stuff",
      "--cwd",
      "/tmp",
      "--adapter",
      "codex",
    ]);
    expect(slots).toEqual([{ adapter: "claude-code" }, { adapter: "codex" }]);
  });

  it("throws when --model appears before --adapter", () => {
    expect(() =>
      parseAdapterSlots(["--model", "opus", "--adapter", "claude-code"]),
    ).toThrow("--model must follow an --adapter flag");
  });

  it("throws when --adapter has no value", () => {
    expect(() => parseAdapterSlots(["--adapter"])).toThrow(
      "--adapter requires a value",
    );
  });

  it("returns empty array when no --adapter flags", () => {
    const slots = parseAdapterSlots(["launch", "-p", "hello"]);
    expect(slots).toEqual([]);
  });

  it("supports -A and -M shorthand", () => {
    const slots = parseAdapterSlots([
      "-A",
      "claude-code",
      "-M",
      "opus",
      "-A",
      "codex",
    ]);
    expect(slots).toEqual([
      { adapter: "claude-code", model: "opus" },
      { adapter: "codex" },
    ]);
  });
});

// --- orchestrateLaunch integration tests ---

const execFileAsync = promisify(execFile);

/** Create a bare-minimum git repo with an initial commit */
async function createTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-orch-test-"));
  await execFileAsync("git", ["init", dir]);
  await execFileAsync("git", [
    "-C",
    dir,
    "config",
    "user.email",
    "test@test.com",
  ]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "Test"]);
  await execFileAsync("git", [
    "-C",
    dir,
    "commit",
    "--allow-empty",
    "-m",
    "init",
  ]);
  return dir;
}

/** A fake adapter that records launch calls without spawning anything */
function fakeAdapter(): AgentAdapter & { launched: Array<{ cwd: string }> } {
  const launched: Array<{ cwd: string }> = [];
  return {
    name: "fake",
    launched,
    async list() {
      return [];
    },
    async launch(opts) {
      launched.push({ cwd: opts.cwd });
      return {
        id: "fake-session-1",
        adapter: "fake",
        status: "running" as const,
        cwd: opts.cwd,
        startedAt: new Date(),
        pid: 99999,
        meta: {},
      };
    },
    async stop() {},
    async send() {},
    async logs() {
      return "";
    },
  };
}

describe("orchestrateLaunch — single-entry matrix (#39)", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await createTempRepo();
  });

  afterEach(async () => {
    // Clean up worktrees before removing repo
    try {
      await execFileAsync("git", ["-C", repoDir, "worktree", "prune"]);
    } catch {}
    // Remove any sibling worktree directories
    const parent = path.dirname(repoDir);
    const base = path.basename(repoDir);
    const entries = await fs.readdir(parent);
    for (const e of entries) {
      if (e.startsWith(`${base}-`)) {
        await fs.rm(path.join(parent, e), { recursive: true, force: true });
      }
    }
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it("creates a worktree for a single slot with branch field", async () => {
    const adapter = fakeAdapter();
    const result = await orchestrateLaunch({
      slots: [{ adapter: "fake", branch: "test/single-branch" }],
      prompt: "test prompt",
      cwd: repoDir,
      adapters: { fake: adapter },
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].error).toBeUndefined();
    expect(result.results[0].branch).toBe("test/single-branch");
    // The adapter should have been launched in the worktree, not the original repo
    expect(adapter.launched[0].cwd).not.toBe(repoDir);
    expect(adapter.launched[0].cwd).toContain("test-single-branch");
  });

  it("creates a worktree for a single slot without branch (auto-generated)", async () => {
    const adapter = fakeAdapter();
    const result = await orchestrateLaunch({
      slots: [{ adapter: "fake" }],
      prompt: "test prompt",
      cwd: repoDir,
      adapters: { fake: adapter },
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].error).toBeUndefined();
    // Branch is auto-generated as try/<groupId>/<suffix>
    expect(result.results[0].branch).toMatch(/^try\/g-[a-f0-9]{6}\/fake$/);
    // Launched in worktree, not original repo
    expect(adapter.launched[0].cwd).not.toBe(repoDir);
  });
});
