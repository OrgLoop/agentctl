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
  resolveBinaryPath: async () => "/usr/local/bin/codex",
}));

// Import after mocks are declared (vitest hoists vi.mock)
const { CodexAdapter } = await import("./codex.js");

let tmpDir: string;
let adapter: InstanceType<typeof CodexAdapter>;

beforeEach(async () => {
  spawnCalls.length = 0;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-codex-launch-"));
  const codexDir = path.join(tmpDir, "codex");
  const sessionsMetaDir = path.join(tmpDir, "codex-sessions");
  await fs.mkdir(path.join(codexDir, "sessions"), { recursive: true });
  await fs.mkdir(sessionsMetaDir, { recursive: true });

  adapter = new CodexAdapter({
    codexDir,
    sessionsMetaDir,
    getPids: async () => new Map(),
    isProcessAlive: () => false,
  });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("CodexAdapter launch", () => {
  it("uses -- separator so dash-prefixed prompts are not parsed as options", async () => {
    const dashPrompt = "---\ntitle: spec\n---\nFix the bug";
    await adapter.launch({
      adapter: "codex",
      prompt: dashPrompt,
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args;
    // -- must appear before the prompt
    const sepIdx = args.indexOf("--");
    const promptIdx = args.indexOf(dashPrompt);
    expect(sepIdx).toBeGreaterThanOrEqual(0);
    expect(promptIdx).toBe(sepIdx + 1);
    expect(args).toEqual([
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      "--cd",
      tmpDir,
      "--",
      dashPrompt,
    ]);
  });

  it("places -- separator after --model flag", async () => {
    await adapter.launch({
      adapter: "codex",
      prompt: "fix the bug",
      model: "gpt-4o",
      cwd: tmpDir,
    });

    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0].args;
    const sepIdx = args.indexOf("--");
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeLessThan(sepIdx);
    expect(args[args.length - 1]).toBe("fix the bug");
    expect(args[args.length - 2]).toBe("--");
  });
});
