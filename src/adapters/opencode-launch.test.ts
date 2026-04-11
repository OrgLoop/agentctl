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
const { OpenCodeAdapter, generateWrapperScript, isModelCompatible } =
  await import("./opencode.js");

let tmpDir: string;
let sessionsMetaDir: string;
let adapter: InstanceType<typeof OpenCodeAdapter>;

beforeEach(async () => {
  spawnCalls.length = 0;
  tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "agentctl-opencode-launch-"),
  );
  const storageDir = path.join(tmpDir, "storage");
  sessionsMetaDir = path.join(tmpDir, "opencode-sessions");
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

describe("generateWrapperScript", () => {
  it("generates a shell script that runs the binary and writes exit code", () => {
    const script = generateWrapperScript(
      "/usr/local/bin/opencode",
      ["run", "--model", "gpt-4", "--", "fix bug"],
      "/tmp/test.exit",
    );
    expect(script).toContain("#!/bin/sh");
    expect(script).toContain("/usr/local/bin/opencode");
    expect(script).toContain("'--model'");
    expect(script).toContain("'gpt-4'");
    expect(script).toContain("'fix bug'");
    expect(script).toContain("EC=$?");
    expect(script).toContain("'/tmp/test.exit'");
  });

  it("shell-escapes single quotes in arguments", () => {
    const script = generateWrapperScript(
      "/usr/local/bin/opencode",
      ["run", "--", "it's a bug"],
      "/tmp/test.exit",
    );
    expect(script).toContain("'it'\\''s a bug'");
  });

  it("detects fast exits (< 5s) and overrides exit code 0 to 1", () => {
    const script = generateWrapperScript(
      "/usr/local/bin/opencode",
      ["run", "--", "test"],
      "/tmp/test.exit",
    );
    // Wrapper should record start time and check elapsed
    expect(script).toContain("START=$(date +%s)");
    expect(script).toContain("END=$(date +%s)");
    expect(script).toContain("ELAPSED=$((END - START))");
    // If exit code is 0 and runtime < 5s threshold, override to 1
    expect(script).toContain(
      'if [ "$EC" -eq 0 ] && [ "$ELAPSED" -lt 5 ]; then EC=1; fi',
    );
  });
});

describe("OpenCodeAdapter launch", () => {
  it("spawns /bin/sh with a wrapper script", async () => {
    await adapter.launch({
      adapter: "opencode",
      prompt: "fix the bug",
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd).toBe("/bin/sh");
    // The arg is the wrapper script path
    const wrapperPath = spawnCalls[0].args[0];
    expect(wrapperPath).toContain("wrapper-");
    expect(wrapperPath).toContain(".sh");
  });

  it("wrapper script includes --model flag when opts.model is set", async () => {
    await adapter.launch({
      adapter: "opencode",
      prompt: "fix the bug",
      model: "deepseek-r1",
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const wrapperPath = spawnCalls[0].args[0];
    const wrapperContent = await fs.readFile(wrapperPath, "utf-8");

    expect(wrapperContent).toContain("'--model'");
    expect(wrapperContent).toContain("'deepseek-r1'");
    expect(wrapperContent).toContain("/usr/local/bin/opencode");
  });

  it("wrapper script omits --model flag when opts.model is not set", async () => {
    await adapter.launch({
      adapter: "opencode",
      prompt: "fix the bug",
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const wrapperPath = spawnCalls[0].args[0];
    const wrapperContent = await fs.readFile(wrapperPath, "utf-8");

    expect(wrapperContent).not.toContain("'--model'");
    expect(wrapperContent).toContain("'run'");
    expect(wrapperContent).toContain("'fix the bug'");
  });

  it("wrapper script includes -- before prompts starting with dashes", async () => {
    const dashPrompt = "---\ntitle: My Spec\n---\nBuild this.";
    await adapter.launch({
      adapter: "opencode",
      prompt: dashPrompt,
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const wrapperPath = spawnCalls[0].args[0];
    const wrapperContent = await fs.readFile(wrapperPath, "utf-8");

    expect(wrapperContent).toContain("'--'");
  });

  it("wrapper writes .exit file alongside session meta", async () => {
    await adapter.launch({
      adapter: "opencode",
      prompt: "fix the bug",
      cwd: tmpDir,
    });

    const wrapperPath = spawnCalls[0].args[0];
    const wrapperContent = await fs.readFile(wrapperPath, "utf-8");

    // Wrapper should reference a .exit file in the sessions meta dir
    expect(wrapperContent).toContain(".exit");
    expect(wrapperContent).toContain("EC=$?");
    expect(wrapperContent).toContain('echo "$EC"');
  });

  it("creates a fuse entry for the launched session", async () => {
    const session = await adapter.launch({
      adapter: "opencode",
      prompt: "fix the bug",
      cwd: tmpDir,
    });

    expect(session.status).toBe("running");
    expect(session.pid).toBe(99999);
    expect(session.adapter).toBe("opencode");
  });

  it("persists session metadata with cwd and model", async () => {
    const session = await adapter.launch({
      adapter: "opencode",
      prompt: "fix the bug",
      model: "gpt-4o",
      cwd: tmpDir,
    });

    const metaPath = path.join(sessionsMetaDir, `${session.id}.json`);
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
    expect(meta.cwd).toBe(tmpDir);
    expect(meta.model).toBe("gpt-4o");
    expect(meta.prompt).toBe("fix the bug");
    expect(meta.adapter).toBe("opencode");
  });

  it("drops provider-prefixed model and uses no --model flag", async () => {
    const session = await adapter.launch({
      adapter: "opencode",
      prompt: "fix the bug",
      model: "openai/gpt-5.4",
      cwd: tmpDir,
    });

    const wrapperPath = spawnCalls[0].args[0];
    const wrapperContent = await fs.readFile(wrapperPath, "utf-8");

    // Provider-prefixed model should NOT be passed to opencode
    expect(wrapperContent).not.toContain("'--model'");
    expect(wrapperContent).not.toContain("openai/gpt-5.4");

    // Session metadata should reflect no model (opencode picks its own default)
    expect(session.model).toBeUndefined();
  });

  it("passes compatible bare model names through to opencode", async () => {
    const session = await adapter.launch({
      adapter: "opencode",
      prompt: "fix the bug",
      model: "deepseek-r1",
      cwd: tmpDir,
    });

    const wrapperPath = spawnCalls[0].args[0];
    const wrapperContent = await fs.readFile(wrapperPath, "utf-8");

    expect(wrapperContent).toContain("'--model'");
    expect(wrapperContent).toContain("'deepseek-r1'");
    expect(session.model).toBe("deepseek-r1");
  });
});

describe("isModelCompatible", () => {
  it("accepts bare model names", () => {
    expect(isModelCompatible("gpt-4o")).toBe(true);
    expect(isModelCompatible("deepseek-r1")).toBe(true);
    expect(isModelCompatible("claude-sonnet-4-5-20250514")).toBe(true);
  });

  it("rejects provider-prefixed model names", () => {
    expect(isModelCompatible("openai/gpt-5.4")).toBe(false);
    expect(isModelCompatible("anthropic/claude-opus-4-6")).toBe(false);
    expect(isModelCompatible("google/gemini-pro")).toBe(false);
  });
});
