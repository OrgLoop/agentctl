import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PidInfo, SlateAdapter } from "./slate.js";

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

// --- Helper to create fake session metadata + log ---

interface FakeSessionOpts {
  sessionId: string;
  pid?: number;
  logContent?: string;
  launchedAt?: string;
  startTime?: string;
}

async function createFakeSession(opts: FakeSessionOpts) {
  const logPath = path.join(sessionsMetaDir, `launch-${Date.now()}.log`);
  if (opts.logContent) {
    await fs.writeFile(logPath, opts.logContent);
  }

  const meta = {
    sessionId: opts.sessionId,
    pid: opts.pid || 12345,
    startTime: opts.startTime || "Thu Mar 12 10:00:00 2026",
    launchedAt: opts.launchedAt || new Date().toISOString(),
    logPath,
  };

  await fs.writeFile(
    path.join(sessionsMetaDir, `${opts.sessionId}.json`),
    JSON.stringify(meta, null, 2),
  );

  return { logPath, meta };
}

/** Build a Claude Code SDK-compatible JSONL log */
function buildStreamJsonLog(messages: Array<Record<string, unknown>>): string {
  return messages.map((m) => JSON.stringify(m)).join("\n");
}

// --- Tests ---

describe("SlateAdapter", () => {
  it("has correct id", () => {
    expect(adapter.id).toBe("slate");
  });

  describe("discover()", () => {
    it("returns empty array when no sessions exist", async () => {
      const sessions = await adapter.discover();
      expect(sessions).toEqual([]);
    });

    it("discovers stopped sessions from metadata", async () => {
      const log = buildStreamJsonLog([
        {
          type: "user",
          sessionId: "sess-1",
          cwd: "/tmp/project",
          message: { role: "user", content: "hello world" },
        },
        {
          type: "assistant",
          sessionId: "sess-1",
          message: {
            role: "assistant",
            content: "Hi there!",
            model: "claude-sonnet-4-5-20250929",
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        },
      ]);

      await createFakeSession({ sessionId: "sess-1", logContent: log });

      const sessions = await adapter.discover();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("sess-1");
      expect(sessions[0].status).toBe("stopped");
      expect(sessions[0].adapter).toBe("slate");
      expect(sessions[0].cwd).toBe("/tmp/project");
      expect(sessions[0].model).toBe("claude-sonnet-4-5-20250929");
      expect(sessions[0].tokens).toEqual({ in: 100, out: 50 });
    });

    it("detects running sessions when PID is alive", async () => {
      const aliveAdapter = new SlateAdapter({
        slateDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: (pid) => pid === 42,
      });

      await createFakeSession({ sessionId: "sess-alive", pid: 42 });

      const sessions = await aliveAdapter.discover();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].pid).toBe(42);
    });
  });

  describe("isAlive()", () => {
    it("returns false for unknown session", async () => {
      expect(await adapter.isAlive("nonexistent")).toBe(false);
    });

    it("returns false when PID is dead", async () => {
      await createFakeSession({ sessionId: "sess-dead", pid: 99999 });
      expect(await adapter.isAlive("sess-dead")).toBe(false);
    });

    it("returns true when PID is alive", async () => {
      const aliveAdapter = new SlateAdapter({
        slateDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: (pid) => pid === 55,
      });

      await createFakeSession({ sessionId: "sess-55", pid: 55 });
      expect(await aliveAdapter.isAlive("sess-55")).toBe(true);
    });

    it("detects PID recycling via start time mismatch", async () => {
      const recycledPids = new Map<number, PidInfo>([
        [
          55,
          {
            pid: 55,
            cwd: "/tmp",
            args: "slate -q",
            startTime: "Fri Mar 13 10:00:00 2026", // different from recorded
          },
        ],
      ]);

      const recycleAdapter = new SlateAdapter({
        slateDir,
        sessionsMetaDir,
        getPids: async () => recycledPids,
        isProcessAlive: () => true,
      });

      await createFakeSession({
        sessionId: "sess-recycled",
        pid: 55,
        startTime: "Thu Mar 12 10:00:00 2026",
      });

      expect(await recycleAdapter.isAlive("sess-recycled")).toBe(false);
    });
  });

  describe("list()", () => {
    it("returns empty array when no sessions exist", async () => {
      const sessions = await adapter.list({ all: true });
      expect(sessions).toEqual([]);
    });

    it("filters by status", async () => {
      await createFakeSession({ sessionId: "sess-1" });

      const running = await adapter.list({ status: "running" });
      expect(running).toEqual([]);

      const stopped = await adapter.list({ status: "stopped", all: true });
      expect(stopped).toHaveLength(1);
    });

    it("hides stopped sessions by default", async () => {
      await createFakeSession({ sessionId: "sess-stopped" });

      const sessions = await adapter.list();
      expect(sessions).toEqual([]);
    });

    it("shows stopped sessions with --all", async () => {
      await createFakeSession({ sessionId: "sess-stopped" });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
    });
  });

  describe("peek()", () => {
    it("returns assistant messages from JSONL log", async () => {
      const log = buildStreamJsonLog([
        {
          type: "user",
          sessionId: "sess-peek",
          message: { role: "user", content: "what is 2+2?" },
        },
        {
          type: "assistant",
          sessionId: "sess-peek",
          message: { role: "assistant", content: "The answer is 4." },
        },
        {
          type: "assistant",
          sessionId: "sess-peek",
          message: { role: "assistant", content: "Anything else?" },
        },
      ]);

      await createFakeSession({ sessionId: "sess-peek", logContent: log });

      const output = await adapter.peek("sess-peek");
      expect(output).toContain("The answer is 4.");
      expect(output).toContain("Anything else?");
    });

    it("respects line limit", async () => {
      const messages = [];
      for (let i = 0; i < 10; i++) {
        messages.push({
          type: "assistant",
          sessionId: "sess-limit",
          message: { role: "assistant", content: `Message ${i}` },
        });
      }
      const log = buildStreamJsonLog(messages);

      await createFakeSession({ sessionId: "sess-limit", logContent: log });

      const output = await adapter.peek("sess-limit", { lines: 3 });
      expect(output).toContain("Message 7");
      expect(output).toContain("Message 8");
      expect(output).toContain("Message 9");
      expect(output).not.toContain("Message 6");
    });

    it("handles array content blocks", async () => {
      const log = buildStreamJsonLog([
        {
          type: "assistant",
          sessionId: "sess-blocks",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "First block" },
              { type: "text", text: "Second block" },
            ],
          },
        },
      ]);

      await createFakeSession({ sessionId: "sess-blocks", logContent: log });

      const output = await adapter.peek("sess-blocks");
      expect(output).toContain("First block");
      expect(output).toContain("Second block");
    });

    it("throws for unknown session", async () => {
      await expect(adapter.peek("nonexistent")).rejects.toThrow(
        "Session not found",
      );
    });
  });

  describe("status()", () => {
    it("returns session details", async () => {
      const log = buildStreamJsonLog([
        {
          type: "assistant",
          sessionId: "sess-status",
          cwd: "/tmp/project",
          message: {
            role: "assistant",
            content: "Hello",
            model: "claude-sonnet-4-5-20250929",
            usage: { input_tokens: 200, output_tokens: 100 },
          },
        },
      ]);

      await createFakeSession({ sessionId: "sess-status", logContent: log });

      const session = await adapter.status("sess-status");
      expect(session.id).toBe("sess-status");
      expect(session.adapter).toBe("slate");
      expect(session.status).toBe("stopped");
      expect(session.model).toBe("claude-sonnet-4-5-20250929");
      expect(session.tokens).toEqual({ in: 200, out: 100 });
    });

    it("throws for unknown session", async () => {
      await expect(adapter.status("nonexistent")).rejects.toThrow(
        "Session not found",
      );
    });
  });

  describe("stop()", () => {
    it("throws when no PID found", async () => {
      await expect(adapter.stop("nonexistent")).rejects.toThrow(
        "No running process",
      );
    });
  });

  describe("stream-json parsing", () => {
    it("aggregates tokens across multiple assistant messages", async () => {
      const log = buildStreamJsonLog([
        {
          type: "assistant",
          sessionId: "sess-tokens",
          message: {
            role: "assistant",
            content: "First response",
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        },
        {
          type: "assistant",
          sessionId: "sess-tokens",
          message: {
            role: "assistant",
            content: "Second response",
            usage: { input_tokens: 200, output_tokens: 100 },
          },
        },
      ]);

      await createFakeSession({ sessionId: "sess-tokens", logContent: log });

      const session = await adapter.status("sess-tokens");
      expect(session.tokens).toEqual({ in: 300, out: 150 });
    });

    it("extracts first user prompt", async () => {
      const log = buildStreamJsonLog([
        {
          type: "user",
          sessionId: "sess-prompt",
          message: { role: "user", content: "Build me a web app" },
        },
        {
          type: "assistant",
          sessionId: "sess-prompt",
          message: { role: "assistant", content: "Sure!" },
        },
      ]);

      await createFakeSession({ sessionId: "sess-prompt", logContent: log });

      const session = await adapter.status("sess-prompt");
      expect(session.prompt).toBe("Build me a web app");
    });

    it("skips malformed JSONL lines gracefully", async () => {
      const log = [
        "not valid json",
        JSON.stringify({
          type: "assistant",
          sessionId: "sess-malformed",
          message: { role: "assistant", content: "Valid message" },
        }),
        "{broken json",
      ].join("\n");

      await createFakeSession({
        sessionId: "sess-malformed",
        logContent: log,
      });

      const output = await adapter.peek("sess-malformed");
      expect(output).toBe("Valid message");
    });
  });
});
