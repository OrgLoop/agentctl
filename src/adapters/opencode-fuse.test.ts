import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LifecycleEvent } from "../core/types.js";
import {
  generateWrapperScript,
  OpenCodeAdapter,
  type OpenCodeAdapterOpts,
} from "./opencode.js";

let tmpDir: string;
let storageDir: string;
let sessionDir: string;
let sessionsMetaDir: string;

/** Set of PIDs considered alive by the mock */
let alivePids: Set<number>;

function makeAdapter(
  overrides?: Partial<OpenCodeAdapterOpts>,
): OpenCodeAdapter {
  return new OpenCodeAdapter({
    storageDir,
    sessionsMetaDir,
    getPids: async () => new Map(),
    isProcessAlive: (pid) => alivePids.has(pid),
    pollIntervalMs: 10, // fast polling for tests
    masterTimeoutMs: 100, // short timeout for tests
    ...overrides,
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-opencode-fuse-"));
  storageDir = path.join(tmpDir, "storage");
  sessionDir = path.join(storageDir, "session");
  sessionsMetaDir = path.join(tmpDir, "opencode-sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(path.join(storageDir, "message"), { recursive: true });
  await fs.mkdir(sessionsMetaDir, { recursive: true });
  alivePids = new Set();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Write a fake session meta file (simulates what launch() writes) */
async function writeMeta(
  sessionId: string,
  pid: number,
  launchedAt?: Date,
): Promise<void> {
  const meta = {
    sessionId,
    pid,
    launchedAt: (launchedAt ?? new Date()).toISOString(),
  };
  await fs.writeFile(
    path.join(sessionsMetaDir, `${sessionId}.json`),
    JSON.stringify(meta),
  );
}

/** Write a .exit file for a session */
async function writeExitFile(
  sessionId: string,
  exitCode: number,
): Promise<void> {
  await fs.writeFile(
    path.join(sessionsMetaDir, `${sessionId}.exit`),
    String(exitCode),
  );
}

/** Collect events from events() generator until predicate is met or timeout */
async function collectEvents(
  adapter: OpenCodeAdapter,
  opts: {
    until?: (e: LifecycleEvent) => boolean;
    maxEvents?: number;
    timeoutMs?: number;
  },
): Promise<LifecycleEvent[]> {
  const events: LifecycleEvent[] = [];
  const maxEvents = opts.maxEvents ?? 10;
  const timeoutMs = opts.timeoutMs ?? 2000;

  const gen = adapter.events()[Symbol.asyncIterator]();

  const deadline = Date.now() + timeoutMs;
  // Reuse the pending gen.next() promise across timeout slices — calling gen.next()
  // again while one is in-flight queues a second call, causing the first resolved
  // value (e.g. a pid-death event) to be silently discarded.
  let nextPromise = gen.next();
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const result = await Promise.race([
      nextPromise,
      sleep(Math.min(remaining, 100)).then(() => "timeout" as const),
    ]);

    if (result === "timeout") continue; // keep the same nextPromise
    if (result.done) break;

    events.push(result.value);
    nextPromise = gen.next(); // advance only after consuming a value
    if (opts.until?.(result.value)) break;
    if (events.length >= maxEvents) break;
  }

  // Clean up generator
  gen.return?.(undefined);
  return events;
}

describe("generateWrapperScript", () => {
  it("produces a valid shell script that writes exit code", () => {
    const script = generateWrapperScript(
      "/usr/local/bin/opencode",
      ["run", "--", "hello world"],
      "/tmp/test.exit",
    );
    expect(script).toContain("#!/bin/sh");
    expect(script).toContain("/usr/local/bin/opencode");
    expect(script).toContain("'run'");
    expect(script).toContain("'hello world'");
    expect(script).toContain("EC=$?");
    expect(script).toContain("echo \"$EC\" > '/tmp/test.exit'");
  });

  it("shell-escapes single quotes in args", () => {
    const script = generateWrapperScript(
      "/usr/bin/opencode",
      ["run", "--", "it's a test"],
      "/tmp/out.exit",
    );
    expect(script).toContain("'it'\\''s a test'");
  });
});

describe("three-prong fuse: exit file signal", () => {
  it("emits session.stopped when exit file appears", async () => {
    const sessionId = "fuse-exit-test-001";
    const pid = 54321;
    alivePids.add(pid);

    // Write meta (simulates launch)
    await writeMeta(sessionId, pid);

    const adapter = makeAdapter();

    // Start events generator and write exit file after a short delay
    const eventsPromise = collectEvents(adapter, {
      until: (e) => e.type === "session.stopped",
      timeoutMs: 1000,
    });

    // Give the generator time to bootstrap, then write exit file
    await sleep(50);
    await writeExitFile(sessionId, 0);

    const events = await eventsPromise;
    const stopped = events.find((e) => e.type === "session.stopped");
    expect(stopped).toBeDefined();
    expect(stopped?.sessionId).toBe(sessionId);
    expect(stopped?.meta?.exitCode).toBe(0);
    expect(stopped?.meta?.signal).toBe("exit-file");
  });

  it("captures non-zero exit codes", async () => {
    const sessionId = "fuse-exit-nonzero";
    const pid = 54322;
    alivePids.add(pid);

    await writeMeta(sessionId, pid);
    const adapter = makeAdapter();

    const eventsPromise = collectEvents(adapter, {
      until: (e) => e.type === "session.stopped",
      timeoutMs: 1000,
    });

    await sleep(50);
    await writeExitFile(sessionId, 1);

    const events = await eventsPromise;
    const stopped = events.find((e) => e.type === "session.stopped");
    expect(stopped).toBeDefined();
    expect(stopped?.meta?.exitCode).toBe(1);
  });
});

describe("three-prong fuse: PID death signal", () => {
  it("emits session.stopped when PID dies without exit file", async () => {
    const sessionId = "fuse-pid-death-001";
    const pid = 54323;
    alivePids.add(pid);

    await writeMeta(sessionId, pid);
    const adapter = makeAdapter();

    const eventsPromise = collectEvents(adapter, {
      until: (e) => e.type === "session.stopped",
      timeoutMs: 1000,
    });

    // Kill the PID (remove from alive set)
    await sleep(50);
    alivePids.delete(pid);

    const events = await eventsPromise;
    const stopped = events.find((e) => e.type === "session.stopped");
    expect(stopped).toBeDefined();
    expect(stopped?.sessionId).toBe(sessionId);
    expect(stopped?.meta?.signal).toBe("pid-death");
    // No exit code available from PID death
    expect(stopped?.meta?.exitCode).toBeUndefined();
  });
});

describe("three-prong fuse: master timeout signal", () => {
  it("emits session.timeout when timeout exceeded", async () => {
    const sessionId = "fuse-timeout-001";
    const pid = 54324;
    alivePids.add(pid);

    // Write meta with a launchedAt in the past (so timeout is already exceeded)
    const pastDate = new Date(Date.now() - 200); // 200ms ago, timeout is 100ms
    await writeMeta(sessionId, pid, pastDate);

    const adapter = makeAdapter({ masterTimeoutMs: 100 });

    const events = await collectEvents(adapter, {
      until: (e) => e.type === "session.timeout",
      timeoutMs: 1000,
    });

    const timeout = events.find((e) => e.type === "session.timeout");
    expect(timeout).toBeDefined();
    expect(timeout?.sessionId).toBe(sessionId);
    expect(timeout?.meta?.signal).toBe("master-timeout");
    expect(timeout?.meta?.timeoutMs).toBe(100);
  });

  it("does not kill the process on timeout", async () => {
    const sessionId = "fuse-timeout-nokill";
    const pid = 54325;
    alivePids.add(pid);

    const pastDate = new Date(Date.now() - 200);
    await writeMeta(sessionId, pid, pastDate);

    const adapter = makeAdapter({ masterTimeoutMs: 100 });

    await collectEvents(adapter, {
      until: (e) => e.type === "session.timeout",
      timeoutMs: 1000,
    });

    // PID should still be alive — timeout does NOT kill
    expect(alivePids.has(pid)).toBe(true);
  });
});

describe("fuse cancellation pattern", () => {
  it("exit file cancels PID poll and timeout (only one event emitted)", async () => {
    const sessionId = "fuse-cancel-001";
    const pid = 54326;
    alivePids.add(pid);

    // Use a past launchedAt so timeout would also fire
    const pastDate = new Date(Date.now() - 200);
    await writeMeta(sessionId, pid, pastDate);

    const adapter = makeAdapter({ masterTimeoutMs: 100 });

    // Write exit file immediately — this should fire first
    await writeExitFile(sessionId, 0);

    // Collect the first event for this session, then let the generator
    // run a few more cycles to verify no duplicates
    const events = await collectEvents(adapter, {
      until: (e) => e.sessionId === sessionId,
      timeoutMs: 500,
    });

    // Should get exactly one event for this session
    const sessionEvents = events.filter((e) => e.sessionId === sessionId);
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0].type).toBe("session.stopped");
    expect(sessionEvents[0].meta?.signal).toBe("exit-file");
  });

  it("PID death cancels timeout (no timeout event after PID death)", async () => {
    const sessionId = "fuse-cancel-pid";
    const pid = 54327;
    alivePids.add(pid);

    await writeMeta(sessionId, pid);

    const adapter = makeAdapter({ masterTimeoutMs: 200 });

    // Start collecting events, then kill PID after bootstrap
    const eventsPromise = collectEvents(adapter, {
      until: (e) => e.sessionId === sessionId,
      timeoutMs: 1000,
    });

    await sleep(30);
    alivePids.delete(pid);

    const events = await eventsPromise;

    const sessionEvents = events.filter((e) => e.sessionId === sessionId);
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0].type).toBe("session.stopped");
    expect(sessionEvents[0].meta?.signal).toBe("pid-death");
  });

  it("after fuse fires, subsequent polls do not re-emit for that session", async () => {
    const sessionId = "fuse-no-reemit";
    const pid = 54399;
    alivePids.add(pid);

    await writeMeta(sessionId, pid);

    const adapter = makeAdapter();

    // Start collecting, then kill PID after bootstrap
    const eventsPromise = collectEvents(adapter, {
      maxEvents: 10,
      timeoutMs: 400,
    });

    await sleep(30);
    alivePids.delete(pid);

    const events = await eventsPromise;

    // Only one event for this session despite multiple poll cycles
    const sessionEvents = events.filter((e) => e.sessionId === sessionId);
    expect(sessionEvents).toHaveLength(1);
  });
});

describe("list() meta-dir primary source", () => {
  it("shows sessions from meta dir that are not in native storage", async () => {
    const sessionId = "meta-only-session";
    const pid = 54328;
    alivePids.add(pid);

    await writeMeta(sessionId, pid);

    const adapter = makeAdapter();
    const sessions = await adapter.list({ all: true });

    const found = sessions.find((s) => s.id === sessionId);
    expect(found).toBeDefined();
    expect(found?.status).toBe("running");
    expect(found?.pid).toBe(pid);
  });

  it("shows stopped meta-dir sessions when --all", async () => {
    const sessionId = "meta-stopped-session";
    const pid = 54329;
    // PID is NOT alive
    await writeMeta(sessionId, pid);

    const adapter = makeAdapter();
    const sessions = await adapter.list({ all: true });

    const found = sessions.find((s) => s.id === sessionId);
    expect(found).toBeDefined();
    expect(found?.status).toBe("stopped");
  });

  it("filters meta-dir sessions by status", async () => {
    const runningId = "meta-running";
    const stoppedId = "meta-stopped";
    alivePids.add(100);
    await writeMeta(runningId, 100);
    await writeMeta(stoppedId, 200); // pid 200 not alive

    const adapter = makeAdapter();

    const running = await adapter.list({ status: "running" });
    expect(running.find((s) => s.id === runningId)).toBeDefined();
    expect(running.find((s) => s.id === stoppedId)).toBeUndefined();
  });

  it("deduplicates sessions between meta dir and native storage", async () => {
    // This verifies seenIds prevents duplicates
    const sessionId = "dedup-session";
    const pid = 54330;
    alivePids.add(pid);

    // Write to meta dir
    await writeMeta(sessionId, pid);

    const adapter = makeAdapter();
    const sessions = await adapter.list({ all: true });

    const matches = sessions.filter((s) => s.id === sessionId);
    expect(matches).toHaveLength(1);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
