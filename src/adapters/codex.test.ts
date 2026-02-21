import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CodexAdapter,
  type CodexPidInfo,
  type CodexSessionMeta,
} from "./codex.js";

let tmpDir: string;
let codexDir: string;
let sessionsDir: string;
let sessionsMetaDir: string;
let adapter: CodexAdapter;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-codex-test-"));
  codexDir = path.join(tmpDir, ".codex");
  sessionsDir = path.join(codexDir, "sessions");
  sessionsMetaDir = path.join(codexDir, "agentctl", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
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

// --- Helper to create fake Codex session files ---

async function createFakeSession(opts: {
  id: string;
  cwd?: string;
  model?: string;
  prompt?: string;
  agentMessages?: string[];
  tokens?: { in: number; out: number };
  dateStr?: string;
}) {
  const dateStr = opts.dateStr || "2026/02/20";
  const dateDir = path.join(sessionsDir, ...dateStr.split("/"));
  await fs.mkdir(dateDir, { recursive: true });

  const filename = `rollout-2026-02-20T10-00-00-${opts.id}.jsonl`;
  const filePath = path.join(dateDir, filename);

  const lines: string[] = [];

  // session_meta line
  lines.push(
    JSON.stringify({
      timestamp: "2026-02-20T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: opts.id,
        timestamp: "2026-02-20T10:00:00.000Z",
        cwd: opts.cwd || "/tmp",
        originator: "codex_exec",
        cli_version: "0.104.0",
        source: "exec",
        model_provider: "openai",
      },
    }),
  );

  // turn_context with model
  if (opts.model) {
    lines.push(
      JSON.stringify({
        timestamp: "2026-02-20T10:00:00.100Z",
        type: "turn_context",
        payload: {
          turn_id: "test-turn-001",
          cwd: opts.cwd || "/tmp",
          model: opts.model,
        },
      }),
    );
  }

  // user message
  if (opts.prompt) {
    lines.push(
      JSON.stringify({
        timestamp: "2026-02-20T10:00:00.200Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: opts.prompt,
          images: [],
        },
      }),
    );
  }

  // agent messages
  for (const msg of opts.agentMessages || []) {
    lines.push(
      JSON.stringify({
        timestamp: "2026-02-20T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: msg,
        },
      }),
    );
    lines.push(
      JSON.stringify({
        timestamp: "2026-02-20T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: msg }],
        },
      }),
    );
  }

  // token usage
  if (opts.tokens) {
    lines.push(
      JSON.stringify({
        timestamp: "2026-02-20T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: opts.tokens.in,
              output_tokens: opts.tokens.out,
            },
          },
        },
      }),
    );
  }

  // task_complete
  lines.push(
    JSON.stringify({
      timestamp: "2026-02-20T10:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "test-turn-001",
        last_agent_message: opts.agentMessages?.at(-1) || "",
      },
    }),
  );

  await fs.writeFile(filePath, lines.join("\n"));
  return filePath;
}

// --- Tests ---

describe("CodexAdapter", () => {
  it("has correct id", () => {
    expect(adapter.id).toBe("codex");
  });

  describe("list()", () => {
    it("returns empty array when no sessions exist", async () => {
      const sessions = await adapter.list({ all: true });
      expect(sessions).toEqual([]);
    });

    it("returns stopped sessions with --all", async () => {
      await createFakeSession({
        id: "019c7dd9-9b86-7dc1-95fe-7b68b8fd260d",
        cwd: "/tmp",
        model: "gpt-5.2-codex",
        prompt: "Say hello",
        agentMessages: ["Hello!"],
        tokens: { in: 8000, out: 20 },
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("019c7dd9-9b86-7dc1-95fe-7b68b8fd260d");
      expect(sessions[0].status).toBe("stopped");
      expect(sessions[0].adapter).toBe("codex");
      expect(sessions[0].model).toBe("gpt-5.2-codex");
      expect(sessions[0].cwd).toBe("/tmp");
    });

    it("filters by status", async () => {
      await createFakeSession({
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        prompt: "test",
      });

      const running = await adapter.list({ status: "running" });
      expect(running).toHaveLength(0);

      const stopped = await adapter.list({ status: "stopped" });
      expect(stopped).toHaveLength(1);
    });

    it("default list (no opts) only shows running sessions", async () => {
      await createFakeSession({
        id: "default-test-0000-0000-000000000000",
        prompt: "test",
      });

      const sessions = await adapter.list();
      expect(sessions).toHaveLength(0);
    });
  });

  describe("peek()", () => {
    it("returns recent agent messages", async () => {
      await createFakeSession({
        id: "peek-test-0000-0000-000000000000",
        prompt: "What is 2+2?",
        agentMessages: ["2+2 equals 4.", "Anything else?"],
      });

      const output = await adapter.peek("peek-test-0000-0000-000000000000");
      expect(output).toContain("2+2 equals 4.");
      expect(output).toContain("Anything else?");
    });

    it("respects line limit", async () => {
      const messages = Array.from({ length: 10 }, (_, i) => `Message ${i}`);

      await createFakeSession({
        id: "limit-test-0000-0000-000000000000",
        prompt: "test",
        agentMessages: messages,
      });

      const output = await adapter.peek("limit-test-0000-0000-000000000000", {
        lines: 3,
      });
      // Should contain last 3 messages (agent_message events, each appears once)
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
      await createFakeSession({
        id: "abcdef12-3456-7890-abcd-ef1234567890",
        prompt: "prefix test",
        agentMessages: ["Found by prefix!"],
      });

      const output = await adapter.peek("abcdef12");
      expect(output).toContain("Found by prefix!");
    });
  });

  describe("status()", () => {
    it("returns session details", async () => {
      await createFakeSession({
        id: "status-test-0000-0000-000000000000",
        cwd: "/tmp/test-project",
        model: "gpt-5.2-codex",
        prompt: "status check",
        agentMessages: ["Done."],
        tokens: { in: 500, out: 200 },
      });

      const session = await adapter.status(
        "status-test-0000-0000-000000000000",
      );
      expect(session.id).toBe("status-test-0000-0000-000000000000");
      expect(session.adapter).toBe("codex");
      expect(session.status).toBe("stopped");
      expect(session.model).toBe("gpt-5.2-codex");
      expect(session.tokens).toEqual({ in: 500, out: 200 });
    });

    it("throws for unknown session", async () => {
      await expect(adapter.status("nonexistent")).rejects.toThrow(
        "Session not found",
      );
    });
  });

  describe("PID detection", () => {
    it("session shows running when matching PID exists", async () => {
      const sessionCreated = new Date("2026-02-20T10:00:00Z");

      await createFakeSession({
        id: "running-test-0000-0000-000000000000",
        cwd: "/tmp/running-project",
        prompt: "running test",
      });

      const pidMap = new Map<number, CodexPidInfo>();
      pidMap.set(99999, {
        pid: 99999,
        cwd: "/tmp/running-project",
        args: "codex exec --json test",
        startTime: "Thu Feb 20 10:00:05 2026",
      });

      const adapterWithPids = new CodexAdapter({
        codexDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].pid).toBe(99999);
    });

    it("detects recycled PID — old session stays stopped", async () => {
      await createFakeSession({
        id: "recycle-test-0000-0000-000000000000",
        cwd: "/tmp/recycle-test",
        prompt: "recycling test",
      });

      const pidMap = new Map<number, CodexPidInfo>();
      pidMap.set(12345, {
        pid: 12345,
        cwd: "/tmp/recycle-test",
        args: "codex exec --json something",
        // Process started BEFORE the session file was created
        startTime: "Wed Feb 19 08:00:00 2026",
      });

      const adapterWithPids = new CodexAdapter({
        codexDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });

    it("falls back to stopped when startTime is unavailable", async () => {
      await createFakeSession({
        id: "no-start-0000-0000-000000000000",
        cwd: "/tmp/no-start",
        prompt: "no start time",
      });

      const pidMap = new Map<number, CodexPidInfo>();
      pidMap.set(11111, {
        pid: 11111,
        cwd: "/tmp/no-start",
        args: "codex exec --json test",
        // No startTime
      });

      const adapterWithPids = new CodexAdapter({
        codexDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });
  });

  describe("session metadata persistence", () => {
    it("session shows running when persisted metadata has live PID", async () => {
      await createFakeSession({
        id: "detached-test-0000-0000-000000000000",
        cwd: "/tmp/detached-test",
        prompt: "detached test",
      });

      const meta: CodexSessionMeta = {
        sessionId: "detached-test-0000-0000-000000000000",
        pid: 55555,
        startTime: "Thu Feb 20 10:00:01 2026",
        cwd: "/tmp/detached-test",
        launchedAt: "2026-02-20T10:00:00.000Z",
      };
      await fs.writeFile(
        path.join(
          sessionsMetaDir,
          "detached-test-0000-0000-000000000000.json",
        ),
        JSON.stringify(meta),
      );

      const adapterWithLivePid = new CodexAdapter({
        codexDir,
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
      await createFakeSession({
        id: "dead-pid-test-0000-0000-000000000000",
        cwd: "/tmp/dead-pid-test",
        prompt: "dead pid",
      });

      const meta: CodexSessionMeta = {
        sessionId: "dead-pid-test-0000-0000-000000000000",
        pid: 66666,
        startTime: "Thu Feb 20 10:00:01 2026",
        cwd: "/tmp/dead-pid-test",
        launchedAt: "2026-02-20T10:00:00.000Z",
      };
      await fs.writeFile(
        path.join(
          sessionsMetaDir,
          "dead-pid-test-0000-0000-000000000000.json",
        ),
        JSON.stringify(meta),
      );

      const adapterWithDeadPid = new CodexAdapter({
        codexDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithDeadPid.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });

    it("sessions from metadata-only (no JSONL) are discovered", async () => {
      // Session launched but Codex hasn't written to ~/.codex/sessions/ yet
      const meta: CodexSessionMeta = {
        sessionId: "meta-only-test-0000-0000-000000000000",
        pid: 77777,
        startTime: "Thu Feb 20 10:00:01 2026",
        cwd: "/tmp/meta-only",
        model: "gpt-5.2-codex",
        prompt: "meta only test",
        launchedAt: "2026-02-20T10:00:00.000Z",
      };
      await fs.writeFile(
        path.join(
          sessionsMetaDir,
          "meta-only-test-0000-0000-000000000000.json",
        ),
        JSON.stringify(meta),
      );

      const adapterWithLivePid = new CodexAdapter({
        codexDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: (pid) => pid === 77777,
      });

      const sessions = await adapterWithLivePid.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("meta-only-test-0000-0000-000000000000");
      expect(sessions[0].cwd).toBe("/tmp/meta-only");
      expect(sessions[0].status).toBe("running");
    });
  });

  describe("multiple sessions", () => {
    it("returns sessions from different dates", async () => {
      await createFakeSession({
        id: "session-a-0000-0000-000000000000",
        prompt: "session a",
        dateStr: "2026/02/19",
      });

      await createFakeSession({
        id: "session-b-0000-0000-000000000000",
        prompt: "session b",
        dateStr: "2026/02/20",
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(2);
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain("session-a-0000-0000-000000000000");
      expect(ids).toContain("session-b-0000-0000-000000000000");
    });
  });

  describe("token tracking", () => {
    it("extracts token usage from JSONL", async () => {
      await createFakeSession({
        id: "token-test-0000-0000-000000000000",
        prompt: "tokens",
        tokens: { in: 8173, out: 17 },
      });

      const session = await adapter.status(
        "token-test-0000-0000-000000000000",
      );
      expect(session.tokens).toEqual({ in: 8173, out: 17 });
    });
  });
});
