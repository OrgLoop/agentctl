import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeProjDir,
  encodeProjDir,
  type LaunchedSessionMeta,
  type PidInfo,
  PiRustAdapter,
} from "./pi-rust.js";

let tmpDir: string;
let sessionDir: string;
let sessionsMetaDir: string;
let adapter: PiRustAdapter;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-pi-rust-test-"));
  sessionDir = path.join(tmpDir, "sessions");
  sessionsMetaDir = path.join(tmpDir, "agentctl-meta");
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

// --- Helper to create fake Pi Rust sessions ---

interface FakeSessionOpts {
  id: string;
  cwd: string;
  timestamp: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  messages?: Array<Record<string, unknown>>;
}

async function createFakeSession(opts: FakeSessionOpts): Promise<string> {
  const projDir = encodeProjDir(opts.cwd);
  const projPath = path.join(sessionDir, projDir);
  await fs.mkdir(projPath, { recursive: true });

  const shortId = opts.id.split("-")[0];
  const tsForFilename = opts.timestamp.replace(/:/g, "-");
  const filename = `${tsForFilename}_${shortId}.jsonl`;

  const header = {
    type: "session",
    version: 3,
    id: opts.id,
    timestamp: opts.timestamp,
    cwd: opts.cwd,
    provider: opts.provider || "anthropic",
    modelId: opts.modelId || "claude-opus-4-6",
    thinkingLevel: opts.thinkingLevel || "medium",
  };

  const lines = [JSON.stringify(header)];

  if (opts.messages) {
    for (const msg of opts.messages) {
      lines.push(JSON.stringify(msg));
    }
  }

  const filePath = path.join(projPath, filename);
  await fs.writeFile(filePath, lines.join("\n"));
  return filePath;
}

// --- Tests ---

describe("PiRustAdapter", () => {
  it("has correct id", () => {
    expect(adapter.id).toBe("pi-rust");
  });

  describe("decodeProjDir()", () => {
    it("decodes a standard project directory name", () => {
      expect(decodeProjDir("--private-tmp-test-pi-rust--")).toBe(
        "/private/tmp/test/pi/rust",
      );
    });

    it("decodes a home directory path", () => {
      expect(decodeProjDir("--Users-ms-personal-agentctl--")).toBe(
        "/Users/ms/personal/agentctl",
      );
    });

    it("handles single-segment paths", () => {
      expect(decodeProjDir("--tmp--")).toBe("/tmp");
    });

    it("handles empty inner content", () => {
      expect(decodeProjDir("----")).toBe("/");
    });
  });

  describe("encodeProjDir()", () => {
    it("encodes a standard path", () => {
      expect(encodeProjDir("/Users/ms/personal/agentctl")).toBe(
        "--Users-ms-personal-agentctl--",
      );
    });

    it("encodes a simple path", () => {
      expect(encodeProjDir("/tmp")).toBe("--tmp--");
    });

    it("round-trips simple paths (no hyphens in original)", () => {
      const original = "/Users/ms/personal/agentctl";
      expect(decodeProjDir(encodeProjDir(original))).toBe(original);
    });
  });

  describe("list()", () => {
    it("returns empty array when no sessions exist", async () => {
      const sessions = await adapter.list({ all: true });
      expect(sessions).toEqual([]);
    });

    it("returns empty array when session dir does not exist", async () => {
      const missingAdapter = new PiRustAdapter({
        sessionDir: path.join(tmpDir, "nonexistent"),
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });
      const sessions = await missingAdapter.list({ all: true });
      expect(sessions).toEqual([]);
    });

    it("returns stopped sessions with --all", async () => {
      const now = new Date();
      const created = new Date(now.getTime() - 3600_000);

      await createFakeSession({
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        cwd: "/Users/test/my-project",
        timestamp: created.toISOString(),
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        messages: [
          {
            type: "message",
            id: "msg1",
            parentId: null,
            timestamp: created.toISOString(),
            message: {
              role: "user",
              content: "Hello world",
              timestamp: created.getTime(),
            },
          },
          {
            type: "message",
            id: "msg2",
            parentId: "msg1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Hello! How can I help?" }],
              model: "claude-opus-4-6",
              usage: { input: 100, output: 50 },
            },
          },
        ],
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect(sessions[0].status).toBe("stopped");
      expect(sessions[0].model).toBe("claude-opus-4-6");
      expect(sessions[0].adapter).toBe("pi-rust");
    });

    it("filters by status", async () => {
      const now = new Date();
      await createFakeSession({
        id: "filter-test-1111-2222-333333333333",
        cwd: "/Users/test/filter-project",
        timestamp: now.toISOString(),
      });

      const running = await adapter.list({ status: "running" });
      expect(running).toHaveLength(0);

      const stopped = await adapter.list({ status: "stopped" });
      expect(stopped).toHaveLength(1);
    });

    it("default list (no opts) only shows running sessions", async () => {
      const now = new Date();
      await createFakeSession({
        id: "default-test-0000-1111-222222222222",
        cwd: "/Users/test/default-project",
        timestamp: now.toISOString(),
      });

      const sessions = await adapter.list();
      expect(sessions).toHaveLength(0);
    });

    it("skips old stopped sessions without --all", async () => {
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
      await createFakeSession({
        id: "old-session-0000-1111-222222222222",
        cwd: "/Users/test/old-project",
        timestamp: oldDate.toISOString(),
      });

      // Without --all, should skip old stopped sessions
      const sessions = await adapter.list({ status: "stopped" });
      expect(sessions).toHaveLength(0);

      // With --all, should include them
      const allSessions = await adapter.list({ all: true });
      expect(allSessions).toHaveLength(1);
    });

    it("returns sessions from multiple project directories", async () => {
      const now = new Date();
      await createFakeSession({
        id: "project-a-0000-1111-222222222222",
        cwd: "/Users/test/project-a",
        timestamp: now.toISOString(),
      });

      await createFakeSession({
        id: "project-b-0000-1111-222222222222",
        cwd: "/Users/test/project-b",
        timestamp: now.toISOString(),
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(2);
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain("project-a-0000-1111-222222222222");
      expect(ids).toContain("project-b-0000-1111-222222222222");
    });

    it("returns multiple sessions in the same project", async () => {
      const earlier = new Date(Date.now() - 7200_000);
      const later = new Date();

      await createFakeSession({
        id: "earlier-sess-0000-1111-222222222222",
        cwd: "/Users/test/same-project",
        timestamp: earlier.toISOString(),
      });

      await createFakeSession({
        id: "later-sess-0000-1111-222222222222",
        cwd: "/Users/test/same-project",
        timestamp: later.toISOString(),
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(2);
    });

    it("sorts running sessions first, then by most recent", async () => {
      const old = new Date(Date.now() - 7200_000);
      const recent = new Date();

      await createFakeSession({
        id: "old-session-aaaa-bbbb-cccccccccccc",
        cwd: "/Users/test/sort-project",
        timestamp: old.toISOString(),
      });

      await createFakeSession({
        id: "new-session-aaaa-bbbb-cccccccccccc",
        cwd: "/Users/test/sort-project",
        timestamp: recent.toISOString(),
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(2);
      // More recent should come first (both stopped)
      expect(sessions[0].id).toBe("new-session-aaaa-bbbb-cccccccccccc");
      expect(sessions[1].id).toBe("old-session-aaaa-bbbb-cccccccccccc");
    });

    it("ignores non-project directories (no -- prefix)", async () => {
      // Create a non-project dir
      await fs.mkdir(path.join(sessionDir, "not-a-project"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(sessionDir, "not-a-project", "test.jsonl"),
        JSON.stringify({
          type: "session",
          version: 3,
          id: "ghost",
          timestamp: new Date().toISOString(),
          cwd: "/tmp",
        }),
      );

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(0);
    });

    it("ignores malformed JSONL files", async () => {
      const projDir = encodeProjDir("/Users/test/malformed");
      const projPath = path.join(sessionDir, projDir);
      await fs.mkdir(projPath, { recursive: true });
      await fs.writeFile(
        path.join(projPath, "2026-01-01T00-00-00.000Z_bad12345.jsonl"),
        "this is not json\n",
      );

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(0);
    });
  });

  describe("peek()", () => {
    it("returns recent assistant messages", async () => {
      const now = new Date();
      await createFakeSession({
        id: "peek-session-0000-1111-222222222222",
        cwd: "/Users/test/peek-project",
        timestamp: now.toISOString(),
        messages: [
          {
            type: "message",
            id: "u1",
            timestamp: now.toISOString(),
            message: { role: "user", content: "What is 2+2?" },
          },
          {
            type: "message",
            id: "a1",
            parentId: "u1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "2+2 equals 4." }],
              model: "claude-opus-4-6",
            },
          },
          {
            type: "message",
            id: "a2",
            parentId: "a1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              content: "String content works too.",
              model: "claude-opus-4-6",
            },
          },
        ],
      });

      const output = await adapter.peek("peek-session-0000-1111-222222222222");
      expect(output).toContain("2+2 equals 4.");
      expect(output).toContain("String content works too.");
    });

    it("respects line limit", async () => {
      const now = new Date();
      const messages = [];
      for (let i = 0; i < 10; i++) {
        messages.push({
          type: "message",
          id: `a${i}`,
          parentId: i > 0 ? `a${i - 1}` : undefined,
          timestamp: now.toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Message ${i}` }],
          },
        });
      }

      await createFakeSession({
        id: "limit-session-0000-1111-222222222222",
        cwd: "/Users/test/limit-project",
        timestamp: now.toISOString(),
        messages,
      });

      const output = await adapter.peek(
        "limit-session-0000-1111-222222222222",
        {
          lines: 3,
        },
      );
      expect(output).toContain("Message 7");
      expect(output).toContain("Message 8");
      expect(output).toContain("Message 9");
      expect(output).not.toContain("Message 6");
    });

    it("throws for unknown session", async () => {
      await expect(adapter.peek("nonexistent")).rejects.toThrow(
        "Session not found",
      );
    });

    it("supports prefix matching", async () => {
      const now = new Date();
      await createFakeSession({
        id: "abcdef12-3456-7890-abcd-ef1234567890",
        cwd: "/Users/test/prefix-project",
        timestamp: now.toISOString(),
        messages: [
          {
            type: "message",
            id: "a1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Found by prefix!" }],
            },
          },
        ],
      });

      const output = await adapter.peek("abcdef12");
      expect(output).toContain("Found by prefix!");
    });

    it("skips non-assistant messages", async () => {
      const now = new Date();
      await createFakeSession({
        id: "skip-non-asst-0000-1111-222222222222",
        cwd: "/Users/test/skip-project",
        timestamp: now.toISOString(),
        messages: [
          {
            type: "message",
            id: "u1",
            timestamp: now.toISOString(),
            message: { role: "user", content: "Hello" },
          },
          {
            type: "message",
            id: "t1",
            parentId: "u1",
            timestamp: now.toISOString(),
            message: {
              role: "toolResult",
              content: [{ type: "text", text: "tool output" }],
            },
          },
          {
            type: "message",
            id: "a1",
            parentId: "t1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Only this should appear" }],
            },
          },
        ],
      });

      const output = await adapter.peek("skip-non-asst-0000-1111-222222222222");
      expect(output).toBe("Only this should appear");
      expect(output).not.toContain("tool output");
      expect(output).not.toContain("Hello");
    });

    it("skips tool call content blocks", async () => {
      const now = new Date();
      await createFakeSession({
        id: "toolcall-peek-0000-1111-222222222222",
        cwd: "/Users/test/toolcall-project",
        timestamp: now.toISOString(),
        messages: [
          {
            type: "message",
            id: "a1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "tc1",
                  name: "bash",
                  arguments: { command: "ls" },
                },
              ],
            },
          },
          {
            type: "message",
            id: "a2",
            parentId: "a1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Here are the files." }],
            },
          },
        ],
      });

      const output = await adapter.peek("toolcall-peek-0000-1111-222222222222");
      expect(output).toBe("Here are the files.");
    });
  });

  describe("status()", () => {
    it("returns session details", async () => {
      const now = new Date();
      await createFakeSession({
        id: "status-session-0000-1111-222222222222",
        cwd: "/Users/test/status-project",
        timestamp: now.toISOString(),
        provider: "openai",
        modelId: "gpt-5.2-codex",
        thinkingLevel: "xhigh",
        messages: [
          {
            type: "message",
            id: "u1",
            timestamp: now.toISOString(),
            message: { role: "user", content: "status check" },
          },
          {
            type: "message",
            id: "a1",
            parentId: "u1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              model: "gpt-5.2-codex",
              content: [{ type: "text", text: "Done." }],
              usage: { input: 500, output: 200 },
            },
          },
        ],
      });

      const session = await adapter.status(
        "status-session-0000-1111-222222222222",
      );
      expect(session.id).toBe("status-session-0000-1111-222222222222");
      expect(session.adapter).toBe("pi-rust");
      expect(session.status).toBe("stopped");
      expect(session.model).toBe("gpt-5.2-codex");
      expect(session.tokens).toEqual({ in: 500, out: 200 });
      expect(session.meta.provider).toBe("openai");
      expect(session.meta.thinkingLevel).toBe("xhigh");
    });

    it("throws for unknown session", async () => {
      await expect(adapter.status("nonexistent")).rejects.toThrow(
        "Session not found",
      );
    });

    it("returns cwd from session header", async () => {
      const now = new Date();
      await createFakeSession({
        id: "cwd-session-0000-1111-222222222222",
        cwd: "/Users/test/cwd-project",
        timestamp: now.toISOString(),
      });

      const session = await adapter.status(
        "cwd-session-0000-1111-222222222222",
      );
      expect(session.cwd).toBe("/Users/test/cwd-project");
    });

    it("returns first user prompt", async () => {
      const now = new Date();
      await createFakeSession({
        id: "prompt-session-0000-1111-222222222222",
        cwd: "/Users/test/prompt-project",
        timestamp: now.toISOString(),
        messages: [
          {
            type: "model_change",
            id: "mc1",
            timestamp: now.toISOString(),
            provider: "anthropic",
            modelId: "claude-opus-4-6",
          },
          {
            type: "message",
            id: "u1",
            parentId: "mc1",
            timestamp: now.toISOString(),
            message: { role: "user", content: "Build me a spaceship" },
          },
        ],
      });

      const session = await adapter.status(
        "prompt-session-0000-1111-222222222222",
      );
      expect(session.prompt).toBe("Build me a spaceship");
    });

    it("supports prefix matching for session ID", async () => {
      const now = new Date();
      await createFakeSession({
        id: "abcdef12-3456-7890-abcd-ef1234567890",
        cwd: "/Users/test/prefix-status",
        timestamp: now.toISOString(),
      });

      const session = await adapter.status("abcdef12");
      expect(session.id).toBe("abcdef12-3456-7890-abcd-ef1234567890");
    });
  });

  describe("token aggregation", () => {
    it("sums tokens across multiple assistant messages", async () => {
      const now = new Date();
      await createFakeSession({
        id: "token-session-0000-1111-222222222222",
        cwd: "/Users/test/token-project",
        timestamp: now.toISOString(),
        messages: [
          {
            type: "message",
            id: "a1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              model: "claude-opus-4-6",
              content: [{ type: "text", text: "First" }],
              usage: { input: 100, output: 50 },
            },
          },
          {
            type: "message",
            id: "a2",
            parentId: "a1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              model: "claude-opus-4-6",
              content: [{ type: "text", text: "Second" }],
              usage: { input: 200, output: 100 },
            },
          },
        ],
      });

      const session = await adapter.status(
        "token-session-0000-1111-222222222222",
      );
      expect(session.tokens).toEqual({ in: 300, out: 150 });
    });

    it("aggregates cost from usage data", async () => {
      const now = new Date();
      await createFakeSession({
        id: "cost-session-0000-1111-222222222222",
        cwd: "/Users/test/cost-project",
        timestamp: now.toISOString(),
        messages: [
          {
            type: "message",
            id: "a1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "First" }],
              usage: {
                input: 100,
                output: 50,
                cost: { input: 0.01, output: 0.005, total: 0.015 },
              },
            },
          },
          {
            type: "message",
            id: "a2",
            parentId: "a1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Second" }],
              usage: {
                input: 200,
                output: 100,
                cost: { input: 0.02, output: 0.01, total: 0.03 },
              },
            },
          },
        ],
      });

      const session = await adapter.status(
        "cost-session-0000-1111-222222222222",
      );
      expect(session.cost).toBeCloseTo(0.045, 5);
    });

    it("returns undefined tokens when no usage data present", async () => {
      const now = new Date();
      await createFakeSession({
        id: "no-usage-0000-1111-222222222222",
        cwd: "/Users/test/no-usage-project",
        timestamp: now.toISOString(),
        messages: [
          {
            type: "message",
            id: "a1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "No usage data" }],
            },
          },
        ],
      });

      const session = await adapter.status("no-usage-0000-1111-222222222222");
      expect(session.tokens).toBeUndefined();
    });
  });

  describe("model detection", () => {
    it("uses model from assistant message over header modelId", async () => {
      const now = new Date();
      await createFakeSession({
        id: "model-override-0000-1111-222222222222",
        cwd: "/Users/test/model-project",
        timestamp: now.toISOString(),
        modelId: "gpt-4o",
        messages: [
          {
            type: "message",
            id: "a1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              model: "gpt-5.2-codex",
              content: [{ type: "text", text: "Hi" }],
              usage: { input: 10, output: 5 },
            },
          },
        ],
      });

      const session = await adapter.status(
        "model-override-0000-1111-222222222222",
      );
      expect(session.model).toBe("gpt-5.2-codex");
    });

    it("falls back to header modelId when no assistant messages", async () => {
      const now = new Date();
      await createFakeSession({
        id: "model-fallback-0000-1111-222222222222",
        cwd: "/Users/test/model-fallback-project",
        timestamp: now.toISOString(),
        modelId: "claude-opus-4-6",
      });

      const session = await adapter.status(
        "model-fallback-0000-1111-222222222222",
      );
      expect(session.model).toBe("claude-opus-4-6");
    });
  });

  describe("PID recycling detection", () => {
    it("detects recycled PID via cwd match — old session stays stopped", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");
      const processStartTime = "Mon Feb 16 08:00:00 2026";

      await createFakeSession({
        id: "old-session-recycle-1111-222222222222",
        cwd: "/Users/test/pid-recycle-test",
        timestamp: sessionCreated.toISOString(),
      });

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(12345, {
        pid: 12345,
        cwd: "/Users/test/pid/recycle/test",
        args: "pi-rust --print",
        startTime: processStartTime,
      });

      const adapterWithPids = new PiRustAdapter({
        sessionDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
      expect(sessions[0].pid).toBeUndefined();
    });

    it("legitimate process matches — session shows as running", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");
      const processStartTime = "Mon Feb 17 10:00:05 2026";

      await createFakeSession({
        id: "running-session-1111-2222-333333333333",
        cwd: "/Users/test/legit/running/test",
        timestamp: sessionCreated.toISOString(),
      });

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(99999, {
        pid: 99999,
        cwd: "/Users/test/legit/running/test",
        args: "pi-rust --print",
        startTime: processStartTime,
      });

      const adapterWithPids = new PiRustAdapter({
        sessionDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].pid).toBe(99999);
    });

    it("detects recycled PID via sessionId in args — stays stopped", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");
      const processStartTime = "Sun Feb 16 08:00:00 2026";

      await createFakeSession({
        id: "args-session-recycle-1111-222222222222",
        cwd: "/Users/test/args-recycle",
        timestamp: sessionCreated.toISOString(),
      });

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(54321, {
        pid: 54321,
        cwd: "/some/other/path",
        args: "pi-rust --session args-session-recycle-1111-222222222222",
        startTime: processStartTime,
      });

      const adapterWithPids = new PiRustAdapter({
        sessionDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });

    it("falls back to stopped when startTime is unavailable", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      await createFakeSession({
        id: "notime-session-1111-2222-333333333333",
        cwd: "/Users/test/no/starttime/test",
        timestamp: sessionCreated.toISOString(),
      });

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(11111, {
        pid: 11111,
        cwd: "/Users/test/no/starttime/test",
        args: "pi-rust --print",
        // No startTime
      });

      const adapterWithPids = new PiRustAdapter({
        sessionDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });

    it("multiple sessions same project — both match by cwd", async () => {
      const oldCreated = new Date("2026-02-16T10:00:00Z");
      const newCreated = new Date("2026-02-17T10:00:00Z");
      const processStartTime = "Mon Feb 17 10:00:01 2026";

      await createFakeSession({
        id: "old-multi-1111-2222-333333333333",
        cwd: "/Users/test/multi/session/project",
        timestamp: oldCreated.toISOString(),
      });

      await createFakeSession({
        id: "new-multi-1111-2222-333333333333",
        cwd: "/Users/test/multi/session/project",
        timestamp: newCreated.toISOString(),
      });

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(77777, {
        pid: 77777,
        cwd: "/Users/test/multi/session/project",
        args: "pi-rust --print",
        startTime: processStartTime,
      });

      const adapterWithPids = new PiRustAdapter({
        sessionDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(2);

      const oldSession = sessions.find(
        (s) => s.id === "old-multi-1111-2222-333333333333",
      );
      const newSession = sessions.find(
        (s) => s.id === "new-multi-1111-2222-333333333333",
      );

      expect(oldSession?.status).toBe("running");
      expect(newSession?.status).toBe("running");
    });
  });

  describe("session lifecycle — detached processes", () => {
    it("session shows running when persisted metadata has live PID", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      await createFakeSession({
        id: "detached-session-1111-2222-333333333333",
        cwd: "/Users/test/detached-test",
        timestamp: sessionCreated.toISOString(),
      });

      const meta: LaunchedSessionMeta = {
        sessionId: "detached-session-1111-2222-333333333333",
        pid: 55555,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/detached-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(
          sessionsMetaDir,
          "detached-session-1111-2222-333333333333.json",
        ),
        JSON.stringify(meta),
      );

      const adapterWithLivePid = new PiRustAdapter({
        sessionDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: (pid) => pid === 55555,
      });

      const sessions = await adapterWithLivePid.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].pid).toBe(55555);
    });

    it("session shows stopped when persisted PID is dead", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      await createFakeSession({
        id: "dead-detached-1111-2222-333333333333",
        cwd: "/Users/test/dead-detached-test",
        timestamp: sessionCreated.toISOString(),
      });

      const meta: LaunchedSessionMeta = {
        sessionId: "dead-detached-1111-2222-333333333333",
        pid: 66666,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/dead-detached-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "dead-detached-1111-2222-333333333333.json"),
        JSON.stringify(meta),
      );

      const adapterWithDeadPid = new PiRustAdapter({
        sessionDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithDeadPid.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
      expect(sessions[0].pid).toBeUndefined();
    });

    it("cleans up stale metadata when PID is dead", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      await createFakeSession({
        id: "cleanup-session-1111-2222-333333333333",
        cwd: "/Users/test/cleanup-test",
        timestamp: sessionCreated.toISOString(),
      });

      const metaPath = path.join(
        sessionsMetaDir,
        "cleanup-session-1111-2222-333333333333.json",
      );
      const meta: LaunchedSessionMeta = {
        sessionId: "cleanup-session-1111-2222-333333333333",
        pid: 77777,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/cleanup-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(metaPath, JSON.stringify(meta));

      const adapterWithDeadPid = new PiRustAdapter({
        sessionDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });

      await adapterWithDeadPid.list({ all: true });
      await expect(fs.access(metaPath)).rejects.toThrow();
    });

    it("detects PID recycling in persisted metadata via start time", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      await createFakeSession({
        id: "meta-recycle-1111-2222-333333333333",
        cwd: "/Users/test/meta-recycle-test",
        timestamp: sessionCreated.toISOString(),
      });

      const meta: LaunchedSessionMeta = {
        sessionId: "meta-recycle-1111-2222-333333333333",
        pid: 88888,
        startTime: "Sun Feb 16 08:00:00 2026",
        cwd: "/Users/test/meta-recycle-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "meta-recycle-1111-2222-333333333333.json"),
        JSON.stringify(meta),
      );

      const adapterWithRecycledPid = new PiRustAdapter({
        sessionDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: (pid) => pid === 88888,
      });

      const sessions = await adapterWithRecycledPid.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });

    it("old metadata without startTime but with live PID assumes running", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      await createFakeSession({
        id: "meta-notime-1111-2222-333333333333",
        cwd: "/Users/test/meta-notime-test",
        timestamp: sessionCreated.toISOString(),
      });

      const meta: LaunchedSessionMeta = {
        sessionId: "meta-notime-1111-2222-333333333333",
        pid: 99999,
        cwd: "/Users/test/meta-notime-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "meta-notime-1111-2222-333333333333.json"),
        JSON.stringify(meta),
      );

      const adapterWithLivePid = new PiRustAdapter({
        sessionDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: (pid) => pid === 99999,
      });

      const sessions = await adapterWithLivePid.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].pid).toBe(99999);
    });

    it("wrapper dies → pi-rust continues → status shows running", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      await createFakeSession({
        id: "wrapper-dies-1111-2222-333333333333",
        cwd: "/Users/test/wrapper-dies-test",
        timestamp: sessionCreated.toISOString(),
      });

      const meta: LaunchedSessionMeta = {
        sessionId: "wrapper-dies-1111-2222-333333333333",
        pid: 44444,
        wrapperPid: 11111,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/wrapper-dies-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "wrapper-dies-1111-2222-333333333333.json"),
        JSON.stringify(meta),
      );

      const adapterTest = new PiRustAdapter({
        sessionDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: (pid) => pid === 44444,
      });

      const sessions = await adapterTest.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].pid).toBe(44444);
    });

    it("pi-rust completes → status shows stopped", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      await createFakeSession({
        id: "pi-complete-1111-2222-333333333333",
        cwd: "/Users/test/pi-complete-test",
        timestamp: sessionCreated.toISOString(),
        messages: [
          {
            type: "message",
            id: "a1",
            timestamp: new Date("2026-02-17T10:30:00Z").toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "All done!" }],
              model: "claude-opus-4-6",
            },
          },
        ],
      });

      const meta: LaunchedSessionMeta = {
        sessionId: "pi-complete-1111-2222-333333333333",
        pid: 55555,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/pi-complete-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "pi-complete-1111-2222-333333333333.json"),
        JSON.stringify(meta),
      );

      const adapterTest = new PiRustAdapter({
        sessionDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });

      const sessions = await adapterTest.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
      expect(sessions[0].pid).toBeUndefined();
    });

    it("old PID recycled → old session shows stopped", async () => {
      const oldSessionCreated = new Date("2026-02-16T10:00:00Z");

      await createFakeSession({
        id: "recycled-victim-1111-2222-333333333333",
        cwd: "/Users/test/pid-recycled-scenario",
        timestamp: oldSessionCreated.toISOString(),
      });

      const meta: LaunchedSessionMeta = {
        sessionId: "recycled-victim-1111-2222-333333333333",
        pid: 33333,
        startTime: "Sun Feb 16 10:00:01 2026",
        cwd: "/Users/test/pid-recycled-scenario",
        launchedAt: oldSessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(
          sessionsMetaDir,
          "recycled-victim-1111-2222-333333333333.json",
        ),
        JSON.stringify(meta),
      );

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(33333, {
        pid: 33333,
        cwd: "/some/other/project",
        args: "pi-rust --print",
        startTime: "Thu Feb 20 09:00:00 2026",
      });

      const adapterTest = new PiRustAdapter({
        sessionDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: (pid) => pid === 33333,
      });

      const sessions = await adapterTest.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });
  });

  describe("session metadata persistence", () => {
    it("readSessionMeta returns null for nonexistent session", async () => {
      const meta = await adapter.readSessionMeta("nonexistent");
      expect(meta).toBeNull();
    });

    it("readSessionMeta reads back written metadata", async () => {
      const metaData: LaunchedSessionMeta = {
        sessionId: "test-meta-1111-2222-333333333333",
        pid: 12345,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/meta-project",
        launchedAt: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "test-meta-1111-2222-333333333333.json"),
        JSON.stringify(metaData),
      );

      const read = await adapter.readSessionMeta(
        "test-meta-1111-2222-333333333333",
      );
      expect(read).not.toBeNull();
      expect(read?.sessionId).toBe("test-meta-1111-2222-333333333333");
      expect(read?.pid).toBe(12345);
    });

    it("readSessionMeta scans all files for matching sessionId", async () => {
      const metaData: LaunchedSessionMeta = {
        sessionId: "target-session-1111-2222-333333333333",
        pid: 12345,
        cwd: "/test",
        launchedAt: new Date().toISOString(),
      };
      // Write under a different filename
      await fs.writeFile(
        path.join(sessionsMetaDir, "some-other-name.json"),
        JSON.stringify(metaData),
      );

      const read = await adapter.readSessionMeta(
        "target-session-1111-2222-333333333333",
      );
      expect(read).not.toBeNull();
      expect(read?.sessionId).toBe("target-session-1111-2222-333333333333");
    });
  });

  describe("provider and thinking level metadata", () => {
    it("returns provider from session header", async () => {
      const now = new Date();
      await createFakeSession({
        id: "provider-session-1111-2222-333333333333",
        cwd: "/Users/test/provider-project",
        timestamp: now.toISOString(),
        provider: "google",
        modelId: "gemini-2.5-pro",
        thinkingLevel: "high",
      });

      const session = await adapter.status(
        "provider-session-1111-2222-333333333333",
      );
      expect(session.meta.provider).toBe("google");
      expect(session.meta.thinkingLevel).toBe("high");
    });
  });

  describe("session file format", () => {
    it("handles session with model_change and thinking_level_change entries", async () => {
      const now = new Date();
      await createFakeSession({
        id: "format-session-1111-2222-333333333333",
        cwd: "/Users/test/format-project",
        timestamp: now.toISOString(),
        messages: [
          {
            type: "model_change",
            id: "mc1",
            timestamp: now.toISOString(),
            provider: "openai",
            modelId: "gpt-5.2-codex",
          },
          {
            type: "thinking_level_change",
            id: "tlc1",
            parentId: "mc1",
            timestamp: now.toISOString(),
            thinkingLevel: "xhigh",
          },
          {
            type: "message",
            id: "u1",
            parentId: "tlc1",
            timestamp: now.toISOString(),
            message: { role: "user", content: "hello" },
          },
          {
            type: "message",
            id: "a1",
            parentId: "u1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Hi there!" }],
              model: "gpt-5.2-codex",
              usage: { input: 50, output: 10 },
            },
          },
        ],
      });

      const session = await adapter.status(
        "format-session-1111-2222-333333333333",
      );
      expect(session.model).toBe("gpt-5.2-codex");
      expect(session.prompt).toBe("hello");
      expect(session.tokens).toEqual({ in: 50, out: 10 });
    });

    it("handles session with tool calls and tool results", async () => {
      const now = new Date();
      await createFakeSession({
        id: "tool-session-1111-2222-333333333333",
        cwd: "/Users/test/tool-project",
        timestamp: now.toISOString(),
        messages: [
          {
            type: "message",
            id: "u1",
            timestamp: now.toISOString(),
            message: { role: "user", content: "list files" },
          },
          {
            type: "message",
            id: "a1",
            parentId: "u1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "tc1",
                  name: "bash",
                  arguments: { command: "ls" },
                },
              ],
              model: "claude-opus-4-6",
              usage: { input: 100, output: 20 },
              stopReason: "toolUse",
            },
          },
          {
            type: "message",
            id: "tr1",
            parentId: "a1",
            timestamp: now.toISOString(),
            message: {
              role: "toolResult",
              toolCallId: "tc1",
              content: [{ type: "text", text: "README.md\n" }],
              isError: false,
            },
          },
          {
            type: "message",
            id: "a2",
            parentId: "tr1",
            timestamp: now.toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Found README.md" }],
              model: "claude-opus-4-6",
              usage: { input: 150, output: 30 },
              stopReason: "stop",
            },
          },
        ],
      });

      const session = await adapter.status(
        "tool-session-1111-2222-333333333333",
      );
      expect(session.tokens).toEqual({ in: 250, out: 50 });

      const output = await adapter.peek("tool-session-1111-2222-333333333333");
      expect(output).toContain("Found README.md");
    });
  });

  describe("edge cases", () => {
    it("handles empty session file", async () => {
      const projDir = encodeProjDir("/Users/test/empty");
      const projPath = path.join(sessionDir, projDir);
      await fs.mkdir(projPath, { recursive: true });
      await fs.writeFile(
        path.join(projPath, "2026-01-01T00-00-00.000Z_empty123.jsonl"),
        "",
      );

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(0);
    });

    it("handles session file with only header", async () => {
      const now = new Date();
      await createFakeSession({
        id: "header-only-1111-2222-333333333333",
        cwd: "/Users/test/header-only",
        timestamp: now.toISOString(),
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].prompt).toBeUndefined();
      expect(sessions[0].tokens).toBeUndefined();
    });

    it("handles session with non-session first line", async () => {
      const projDir = encodeProjDir("/Users/test/bad-first-line");
      const projPath = path.join(sessionDir, projDir);
      await fs.mkdir(projPath, { recursive: true });
      await fs.writeFile(
        path.join(projPath, "2026-01-01T00-00-00.000Z_bad12345.jsonl"),
        JSON.stringify({
          type: "message",
          id: "x",
          message: { role: "user", content: "test" },
        }),
      );

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(0);
    });

    it("handles concurrent access to metadata", async () => {
      const now = new Date();
      await createFakeSession({
        id: "concurrent-1111-2222-333333333333",
        cwd: "/Users/test/concurrent",
        timestamp: now.toISOString(),
      });

      // Simultaneously list with different adapters
      const adapter1 = new PiRustAdapter({
        sessionDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });
      const adapter2 = new PiRustAdapter({
        sessionDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });

      const [sessions1, sessions2] = await Promise.all([
        adapter1.list({ all: true }),
        adapter2.list({ all: true }),
      ]);

      expect(sessions1).toHaveLength(1);
      expect(sessions2).toHaveLength(1);
      expect(sessions1[0].id).toBe(sessions2[0].id);
    });
  });
});
