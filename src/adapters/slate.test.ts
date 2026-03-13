import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LaunchOpts } from "../core/types.js";
import { buildSlateArgs, type PidInfo, SlateAdapter } from "./slate.js";

let tmpDir: string;
let slateDir: string;
let sessionsMetaDir: string;
let adapter: SlateAdapter;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-slate-test-"));
  slateDir = path.join(tmpDir, ".slate");
  sessionsMetaDir = path.join(slateDir, "agentctl", "sessions");
  await fs.mkdir(sessionsMetaDir, { recursive: true });

  adapter = new SlateAdapter({
    slateDir,
    sessionsMetaDir,
    getPids: async () => new Map(),
    isProcessAlive: () => false,
  });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// --- Helpers ---

async function writeSessionMeta(
  sessionId: string,
  pid: number,
  extra?: { startTime?: string; launchedAt?: string },
) {
  const meta = {
    sessionId,
    pid,
    startTime: extra?.startTime,
    launchedAt: extra?.launchedAt || new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(sessionsMetaDir, `${sessionId}.json`),
    JSON.stringify(meta),
  );
}

async function writeExtendedMeta(
  sessionId: string,
  ext: { cwd?: string; model?: string; prompt?: string; logPath?: string },
) {
  await fs.writeFile(
    path.join(sessionsMetaDir, `${sessionId}.ext.json`),
    JSON.stringify(ext),
  );
}

// --- buildSlateArgs tests ---

describe("buildSlateArgs", () => {
  const baseLaunchOpts: LaunchOpts = {
    adapter: "slate",
    prompt: "fix the bug",
  };

  it("uses -q for the prompt (not -p)", () => {
    const args = buildSlateArgs(baseLaunchOpts);
    expect(args).toContain("-q");
    expect(args).not.toContain("-p");
    const qIdx = args.indexOf("-q");
    expect(args[qIdx + 1]).toBe("fix the bug");
  });

  it("includes --output-format stream-json", () => {
    const args = buildSlateArgs(baseLaunchOpts);
    expect(args).toContain("--output-format");
    const idx = args.indexOf("--output-format");
    expect(args[idx + 1]).toBe("stream-json");
  });

  it("includes --dangerously-set-permissions", () => {
    const args = buildSlateArgs(baseLaunchOpts);
    expect(args).toContain("--dangerously-set-permissions");
  });

  it("includes -w when cwd is provided", () => {
    const args = buildSlateArgs({ ...baseLaunchOpts, cwd: "/tmp/workspace" });
    expect(args).toContain("-w");
    const wIdx = args.indexOf("-w");
    expect(args[wIdx + 1]).toBe("/tmp/workspace");
  });

  it("omits -w when no cwd is provided", () => {
    const args = buildSlateArgs(baseLaunchOpts);
    expect(args).not.toContain("-w");
  });

  it("does not include --model (not supported by Slate CLI)", () => {
    const args = buildSlateArgs({ ...baseLaunchOpts, model: "opus" });
    expect(args).not.toContain("--model");
    expect(args).not.toContain("opus");
  });

  it("handles prompts with special characters", () => {
    const args = buildSlateArgs({
      ...baseLaunchOpts,
      prompt: 'fix the "bug" in file.ts',
    });
    const qIdx = args.indexOf("-q");
    expect(args[qIdx + 1]).toBe('fix the "bug" in file.ts');
  });

  it("handles prompts starting with dashes", () => {
    const args = buildSlateArgs({
      ...baseLaunchOpts,
      prompt: "---\nfrontmatter\n---\nfix it",
    });
    const qIdx = args.indexOf("-q");
    expect(args[qIdx + 1]).toBe("---\nfrontmatter\n---\nfix it");
  });
});

// --- discover tests ---

describe("discover", () => {
  it("returns empty when no sessions exist", async () => {
    const sessions = await adapter.discover();
    expect(sessions).toEqual([]);
  });

  it("discovers stopped sessions from metadata", async () => {
    await writeSessionMeta("sess-1", 12345);
    await writeExtendedMeta("sess-1", {
      cwd: "/tmp/project",
      prompt: "hello",
    });

    const sessions = await adapter.discover();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("sess-1");
    expect(sessions[0].status).toBe("stopped");
    expect(sessions[0].cwd).toBe("/tmp/project");
    expect(sessions[0].prompt).toBe("hello");
  });

  it("discovers running sessions when PID is alive", async () => {
    const runningPids = new Map<number, PidInfo>();
    runningPids.set(99999, {
      pid: 99999,
      cwd: "/tmp",
      args: "slate -q test",
    });

    const liveAdapter = new SlateAdapter({
      slateDir,
      sessionsMetaDir,
      getPids: async () => runningPids,
      isProcessAlive: (pid) => pid === 99999,
    });

    await writeSessionMeta("sess-2", 99999);
    await writeExtendedMeta("sess-2", { cwd: "/tmp" });

    const sessions = await liveAdapter.discover();
    const tracked = sessions.find((s) => s.id === "sess-2");
    expect(tracked).toBeDefined();
    expect(tracked?.status).toBe("running");
    expect(tracked?.pid).toBe(99999);
  });

  it("discovers untracked running slate processes", async () => {
    const runningPids = new Map<number, PidInfo>();
    runningPids.set(77777, {
      pid: 77777,
      cwd: "/tmp/other",
      args: "slate -q something",
    });

    const liveAdapter = new SlateAdapter({
      slateDir,
      sessionsMetaDir,
      getPids: async () => runningPids,
      isProcessAlive: () => true,
    });

    const sessions = await liveAdapter.discover();
    expect(sessions.some((s) => s.id === "slate-pid-77777")).toBe(true);
  });

  it("skips .ext.json files during discovery", async () => {
    await writeSessionMeta("sess-3", 11111);
    await writeExtendedMeta("sess-3", { cwd: "/tmp" });

    const sessions = await adapter.discover();
    // Should only find one session, not treat .ext.json as a session
    const sessionIds = sessions.map((s) => s.id);
    expect(sessionIds).toEqual(["sess-3"]);
  });
});

// --- isAlive tests ---

describe("isAlive", () => {
  it("returns false when session does not exist", async () => {
    expect(await adapter.isAlive("nonexistent")).toBe(false);
  });

  it("returns false when PID is dead", async () => {
    await writeSessionMeta("dead-sess", 12345);
    expect(await adapter.isAlive("dead-sess")).toBe(false);
  });

  it("returns true when PID is alive", async () => {
    const liveAdapter = new SlateAdapter({
      slateDir,
      sessionsMetaDir,
      getPids: async () => new Map(),
      isProcessAlive: (pid) => pid === 44444,
    });

    await writeSessionMeta("live-sess", 44444);
    expect(await liveAdapter.isAlive("live-sess")).toBe(true);
  });
});

// --- list tests ---

describe("list", () => {
  it("filters to running/idle by default", async () => {
    await writeSessionMeta("stopped-1", 11111);

    const sessions = await adapter.list();
    // Session with dead PID = stopped, filtered out by default
    expect(sessions).toHaveLength(0);
  });

  it("includes stopped sessions with { all: true }", async () => {
    await writeSessionMeta("stopped-1", 11111);

    const sessions = await adapter.list({ all: true });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("stopped");
  });

  it("filters by status", async () => {
    await writeSessionMeta("s1", 11111);

    const running = await adapter.list({ status: "running" });
    expect(running).toHaveLength(0);

    const stopped = await adapter.list({ status: "stopped" });
    expect(stopped).toHaveLength(1);
  });
});

// --- peek tests ---

describe("peek", () => {
  it("throws for nonexistent session", async () => {
    await expect(adapter.peek("nonexistent")).rejects.toThrow(
      "Session not found",
    );
  });

  it("reads from log file when available", async () => {
    const logPath = path.join(tmpDir, "test.log");
    await fs.writeFile(logPath, "line1\nline2\nline3\n");

    await writeSessionMeta("peek-sess", 11111);
    await writeExtendedMeta("peek-sess", { logPath });

    const output = await adapter.peek("peek-sess");
    expect(output).toContain("line1");
    expect(output).toContain("line3");
  });

  it("returns fallback message when no log file", async () => {
    await writeSessionMeta("no-log-sess", 11111);

    const output = await adapter.peek("no-log-sess");
    expect(output).toContain("Slate session");
    expect(output).toContain("no-log-sess");
  });

  it("respects lines option", async () => {
    const logPath = path.join(tmpDir, "long.log");
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`);
    await fs.writeFile(logPath, lines.join("\n"));

    await writeSessionMeta("lines-sess", 11111);
    await writeExtendedMeta("lines-sess", { logPath });

    const output = await adapter.peek("lines-sess", { lines: 5 });
    const outputLines = output.split("\n");
    expect(outputLines).toHaveLength(5);
    expect(outputLines[0]).toContain("line-46");
  });
});

// --- status tests ---

describe("status", () => {
  it("throws for nonexistent session", async () => {
    await expect(adapter.status("nonexistent")).rejects.toThrow(
      "Session not found",
    );
  });

  it("returns stopped status for dead PID", async () => {
    await writeSessionMeta("dead-sess", 11111);
    await writeExtendedMeta("dead-sess", {
      cwd: "/tmp",
      model: "sonnet",
      prompt: "test prompt",
    });

    const session = await adapter.status("dead-sess");
    expect(session.status).toBe("stopped");
    expect(session.cwd).toBe("/tmp");
    expect(session.model).toBe("sonnet");
    expect(session.prompt).toBe("test prompt");
    expect(session.pid).toBeUndefined();
  });

  it("returns running status for alive PID", async () => {
    const liveAdapter = new SlateAdapter({
      slateDir,
      sessionsMetaDir,
      getPids: async () => new Map(),
      isProcessAlive: (pid) => pid === 55555,
    });

    await writeSessionMeta("live-sess", 55555);
    await writeExtendedMeta("live-sess", { cwd: "/tmp" });

    const session = await liveAdapter.status("live-sess");
    expect(session.status).toBe("running");
    expect(session.pid).toBe(55555);
  });
});

// --- stop tests ---

describe("stop", () => {
  it("throws when session has no metadata", async () => {
    await expect(adapter.stop("nonexistent")).rejects.toThrow(
      "No running process",
    );
  });

  it("throws when process is already dead", async () => {
    await writeSessionMeta("dead-sess", 11111);

    await expect(adapter.stop("dead-sess")).rejects.toThrow(
      "Process already dead",
    );
  });
});

// --- PID recycling detection ---

describe("PID recycling detection", () => {
  it("detects recycled PID via start time mismatch", async () => {
    const runningPids = new Map<number, PidInfo>();
    runningPids.set(12345, {
      pid: 12345,
      cwd: "/tmp",
      args: "slate -q test",
      startTime: "Thu Mar 12 18:00:00 2026",
    });

    const recycleAdapter = new SlateAdapter({
      slateDir,
      sessionsMetaDir,
      getPids: async () => runningPids,
      isProcessAlive: () => true,
    });

    // Session was launched much earlier
    await writeSessionMeta("recycled-sess", 12345, {
      startTime: "Wed Mar 11 10:00:00 2026",
    });

    const alive = await recycleAdapter.isAlive("recycled-sess");
    expect(alive).toBe(false);
  });
});
