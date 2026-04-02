/**
 * Tests for the session.peek daemon handler — specifically the fix for
 * peek on stopped sessions where the adapter is not known in daemon state.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentAdapter, DiscoveredSession } from "../core/types.js";
import { FuseEngine } from "./fuse-engine.js";
import { LockManager } from "./lock-manager.js";
import { MetricsRegistry } from "./metrics.js";
import { createRequestHandler, type HandlerContext } from "./server.js";
import { SessionTracker } from "./session-tracker.js";
import { StateManager } from "./state.js";

let tmpDir: string;
let state: StateManager;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-server-test-"));
  state = await StateManager.load(tmpDir);
});

afterEach(async () => {
  state.flush();
  await fs.rm(tmpDir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
});

/** Create a minimal AgentAdapter stub whose peek() either returns a string or throws */
function makeAdapter(id: string, peekResult: string | Error): AgentAdapter {
  return {
    id,
    discover: async () => [] as DiscoveredSession[],
    isAlive: async () => false,
    list: async () => [],
    peek: async (_sid: string) => {
      if (peekResult instanceof Error) throw peekResult;
      return peekResult;
    },
    status: async () => {
      throw new Error("not implemented");
    },
    launch: async () => {
      throw new Error("not implemented");
    },
    stop: async () => {
      throw new Error("not implemented");
    },
    resume: async () => {
      throw new Error("not implemented");
    },
    events: async function* () {},
  };
}

function makeContext(adapters: Record<string, AgentAdapter>): HandlerContext {
  const lockManager = new LockManager(state);
  const fuseEngine = new FuseEngine(state, { defaultDurationMs: 60_000 });
  const metrics = new MetricsRegistry(lockManager, fuseEngine);
  const sessionTracker = new SessionTracker(state, { adapters });
  return {
    sessionTracker,
    lockManager,
    fuseEngine,
    metrics,
    adapters,
    state,
    configDir: tmpDir,
    sockPath: path.join(tmpDir, "test.sock"),
    webhookConfig: null,
    emitSessionStoppedWebhook: () => {},
  };
}

describe("session.peek — fan-out for untracked sessions", () => {
  it("returns output from first adapter that succeeds when session not in daemon state", async () => {
    const adapters = {
      "claude-code": makeAdapter("claude-code", new Error("Session not found")),
      "pi-rust": makeAdapter("pi-rust", "Hello from pi-rust"),
    };

    const handler = createRequestHandler(makeContext(adapters));
    const result = await handler({
      method: "session.peek",
      params: { id: "stopped-session-abc123", lines: 20 },
    });

    expect(result).toBe("Hello from pi-rust");
  });

  it("throws Session not found when all adapters fail and session not tracked", async () => {
    const adapters = {
      "claude-code": makeAdapter("claude-code", new Error("Session not found")),
      opencode: makeAdapter("opencode", new Error("Session not found")),
    };

    const handler = createRequestHandler(makeContext(adapters));
    await expect(
      handler({
        method: "session.peek",
        params: { id: "ghost-session-xyz", lines: 20 },
      }),
    ).rejects.toThrow("Session not found");
  });

  it("uses tracked adapter directly without fan-out when session is in daemon state", async () => {
    // Track a session so the daemon knows its adapter
    state.setSession("tracked-session-001", {
      id: "tracked-session-001",
      adapter: "pi-rust",
      status: "stopped",
      startedAt: new Date().toISOString(),
      meta: {},
    });

    const claudeCodePeekCalled = { count: 0 };
    const adapters = {
      "claude-code": {
        ...makeAdapter("claude-code", new Error("Should not be called")),
        peek: async (_sid: string) => {
          claudeCodePeekCalled.count++;
          throw new Error("Should not be called");
        },
      },
      "pi-rust": makeAdapter("pi-rust", "Tracked session output"),
    };

    const handler = createRequestHandler(makeContext(adapters));
    const result = await handler({
      method: "session.peek",
      params: { id: "tracked-session-001", lines: 20 },
    });

    expect(result).toBe("Tracked session output");
    expect(claudeCodePeekCalled.count).toBe(0);
  });

  it("uses --adapter param when provided, skips fan-out", async () => {
    const claudeCodePeekCalled = { count: 0 };
    const adapters = {
      "claude-code": {
        ...makeAdapter("claude-code", new Error("Should not be called")),
        peek: async (_sid: string) => {
          claudeCodePeekCalled.count++;
          throw new Error("Should not be called");
        },
      },
      opencode: makeAdapter("opencode", "Opencode output"),
    };

    const handler = createRequestHandler(makeContext(adapters));
    const result = await handler({
      method: "session.peek",
      params: { id: "some-session", adapter: "opencode", lines: 20 },
    });

    expect(result).toBe("Opencode output");
    expect(claudeCodePeekCalled.count).toBe(0);
  });

  it("stopped session discoverable via any adapter — fan-out finds it", async () => {
    // Simulate: session was run natively with pi (not via agentctl), now stopped.
    // Daemon has no record of it. Pi adapter can still peek at it from disk.
    const adapters = {
      "claude-code": makeAdapter("claude-code", new Error("Session not found")),
      codex: makeAdapter("codex", new Error("Session not found")),
      pi: makeAdapter("pi", "Output from stopped pi session"),
      "pi-rust": makeAdapter("pi-rust", new Error("Session not found")),
    };

    const handler = createRequestHandler(makeContext(adapters));
    const result = await handler({
      method: "session.peek",
      params: { id: "native-pi-session-abc", lines: 20 },
    });

    expect(result).toBe("Output from stopped pi session");
  });
});
