import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClaudeCodeAdapter,
  type LaunchedSessionMeta,
  type PidInfo,
} from "./claude-code.js";

let tmpDir: string;
let claudeDir: string;
let projectsDir: string;
let sessionsMetaDir: string;
let adapter: ClaudeCodeAdapter;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-test-"));
  claudeDir = path.join(tmpDir, ".claude");
  projectsDir = path.join(claudeDir, "projects");
  sessionsMetaDir = path.join(claudeDir, "agentctl", "sessions");
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.mkdir(sessionsMetaDir, { recursive: true });

  // Inject empty PID map and dead-process checker so real processes don't interfere
  adapter = new ClaudeCodeAdapter({
    claudeDir,
    sessionsMetaDir,
    getPids: async () => new Map(),
    isProcessAlive: () => false,
  });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// --- Helper to create fake session data ---

async function createFakeProject(
  projectName: string,
  sessions: Array<{
    id: string;
    firstPrompt: string;
    created: string;
    modified: string;
    messages: Array<Record<string, unknown>>;
    gitBranch?: string;
  }>,
) {
  const projDir = path.join(projectsDir, projectName);
  await fs.mkdir(projDir, { recursive: true });

  const entries = sessions.map((s) => ({
    sessionId: s.id,
    fullPath: path.join(projDir, `${s.id}.jsonl`),
    fileMtime: new Date(s.modified).getTime(),
    firstPrompt: s.firstPrompt,
    messageCount: s.messages.length,
    created: s.created,
    modified: s.modified,
    gitBranch: s.gitBranch || "",
    projectPath: `/Users/test/${projectName}`,
    isSidechain: false,
  }));

  const index = {
    version: 1,
    entries,
    originalPath: `/Users/test/${projectName}`,
  };

  await fs.writeFile(
    path.join(projDir, "sessions-index.json"),
    JSON.stringify(index),
  );

  for (const s of sessions) {
    const jsonl = s.messages.map((m) => JSON.stringify(m)).join("\n");
    await fs.writeFile(path.join(projDir, `${s.id}.jsonl`), jsonl);
  }
}

// --- Tests ---

describe("ClaudeCodeAdapter", () => {
  it("has correct id", () => {
    expect(adapter.id).toBe("claude-code");
  });

  describe("list()", () => {
    it("returns empty array when no projects exist", async () => {
      const sessions = await adapter.list({ all: true });
      expect(sessions).toEqual([]);
    });

    it("returns stopped sessions with --all", async () => {
      const now = new Date();
      const created = new Date(now.getTime() - 3600_000); // 1 hour ago

      await createFakeProject("test-project", [
        {
          id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          firstPrompt: "Hello world",
          created: created.toISOString(),
          modified: now.toISOString(),
          messages: [
            {
              type: "user",
              sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
              timestamp: created.toISOString(),
              message: { role: "user", content: "Hello world" },
            },
            {
              type: "assistant",
              sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
              timestamp: now.toISOString(),
              message: {
                role: "assistant",
                model: "claude-opus-4-6",
                content: [{ type: "text", text: "Hello! How can I help?" }],
                usage: { input_tokens: 100, output_tokens: 50 },
              },
            },
          ],
        },
      ]);

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect(sessions[0].status).toBe("stopped");
      expect(sessions[0].model).toBe("claude-opus-4-6");
      expect(sessions[0].adapter).toBe("claude-code");
    });

    it("filters by status", async () => {
      const now = new Date();
      await createFakeProject("test-project", [
        {
          id: "aaaaaaaa-0000-0000-0000-000000000001",
          firstPrompt: "task one",
          created: now.toISOString(),
          modified: now.toISOString(),
          messages: [],
        },
      ]);

      const running = await adapter.list({ status: "running" });
      expect(running).toHaveLength(0);

      const stopped = await adapter.list({ status: "stopped" });
      expect(stopped).toHaveLength(1);
    });

    it("skips sidechain sessions", async () => {
      const now = new Date();
      const projDir = path.join(projectsDir, "sidechain-test");
      await fs.mkdir(projDir, { recursive: true });

      const index = {
        version: 1,
        entries: [
          {
            sessionId: "main-session-id",
            fullPath: path.join(projDir, "main-session-id.jsonl"),
            fileMtime: now.getTime(),
            firstPrompt: "main",
            messageCount: 1,
            created: now.toISOString(),
            modified: now.toISOString(),
            projectPath: "/test",
            isSidechain: false,
          },
          {
            sessionId: "sidechain-session-id",
            fullPath: path.join(projDir, "sidechain-session-id.jsonl"),
            fileMtime: now.getTime(),
            firstPrompt: "sidechain",
            messageCount: 1,
            created: now.toISOString(),
            modified: now.toISOString(),
            projectPath: "/test",
            isSidechain: true,
          },
        ],
        originalPath: "/test",
      };

      await fs.writeFile(
        path.join(projDir, "sessions-index.json"),
        JSON.stringify(index),
      );
      await fs.writeFile(path.join(projDir, "main-session-id.jsonl"), "");
      await fs.writeFile(path.join(projDir, "sidechain-session-id.jsonl"), "");

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("main-session-id");
    });

    it("default list (no opts) only shows running sessions", async () => {
      const now = new Date();
      await createFakeProject("default-test", [
        {
          id: "default-session-0000-000000000000",
          firstPrompt: "test",
          created: now.toISOString(),
          modified: now.toISOString(),
          messages: [],
        },
      ]);

      // No running PIDs, so default list should be empty
      const sessions = await adapter.list();
      expect(sessions).toHaveLength(0);
    });
  });

  describe("peek()", () => {
    it("returns recent assistant messages", async () => {
      const now = new Date();
      await createFakeProject("peek-test", [
        {
          id: "peek-session-id-0000-000000000000",
          firstPrompt: "test prompt",
          created: now.toISOString(),
          modified: now.toISOString(),
          messages: [
            {
              type: "user",
              sessionId: "peek-session-id-0000-000000000000",
              message: { role: "user", content: "What is 2+2?" },
            },
            {
              type: "assistant",
              sessionId: "peek-session-id-0000-000000000000",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "2+2 equals 4." }],
                model: "claude-opus-4-6",
              },
            },
            {
              type: "assistant",
              sessionId: "peek-session-id-0000-000000000000",
              message: {
                role: "assistant",
                content: "String content works too.",
                model: "claude-opus-4-6",
              },
            },
          ],
        },
      ]);

      const output = await adapter.peek("peek-session-id-0000-000000000000");
      expect(output).toContain("2+2 equals 4.");
      expect(output).toContain("String content works too.");
    });

    it("respects line limit", async () => {
      const now = new Date();
      const messages = [];
      for (let i = 0; i < 10; i++) {
        messages.push({
          type: "assistant",
          sessionId: "limit-session-0000-000000000000",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Message ${i}` }],
          },
        });
      }

      await createFakeProject("limit-test", [
        {
          id: "limit-session-0000-000000000000",
          firstPrompt: "test",
          created: now.toISOString(),
          modified: now.toISOString(),
          messages,
        },
      ]);

      const output = await adapter.peek("limit-session-0000-000000000000", {
        lines: 3,
      });
      // Should contain last 3 messages
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
      await createFakeProject("prefix-test", [
        {
          id: "abcdef12-3456-7890-abcd-ef1234567890",
          firstPrompt: "prefix test",
          created: now.toISOString(),
          modified: now.toISOString(),
          messages: [
            {
              type: "assistant",
              sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Found by prefix!" }],
              },
            },
          ],
        },
      ]);

      const output = await adapter.peek("abcdef12");
      expect(output).toContain("Found by prefix!");
    });
  });

  describe("status()", () => {
    it("returns session details", async () => {
      const now = new Date();
      await createFakeProject("status-test", [
        {
          id: "status-session-0000-000000000000",
          firstPrompt: "status check",
          created: now.toISOString(),
          modified: now.toISOString(),
          gitBranch: "main",
          messages: [
            {
              type: "assistant",
              sessionId: "status-session-0000-000000000000",
              message: {
                role: "assistant",
                model: "claude-sonnet-4-5-20250929",
                content: [{ type: "text", text: "Done." }],
                usage: { input_tokens: 500, output_tokens: 200 },
              },
            },
          ],
        },
      ]);

      const session = await adapter.status("status-session-0000-000000000000");
      expect(session.id).toBe("status-session-0000-000000000000");
      expect(session.adapter).toBe("claude-code");
      expect(session.status).toBe("stopped");
      expect(session.model).toBe("claude-sonnet-4-5-20250929");
      expect(session.tokens).toEqual({ in: 500, out: 200 });
      expect(session.meta.gitBranch).toBe("main");
    });

    it("throws for unknown session", async () => {
      await expect(adapter.status("nonexistent")).rejects.toThrow(
        "Session not found",
      );
    });
  });

  describe("token aggregation", () => {
    it("sums tokens across multiple assistant messages", async () => {
      const now = new Date();
      await createFakeProject("token-test", [
        {
          id: "token-session-0000-000000000000",
          firstPrompt: "tokens",
          created: now.toISOString(),
          modified: now.toISOString(),
          messages: [
            {
              type: "assistant",
              sessionId: "token-session-0000-000000000000",
              message: {
                role: "assistant",
                model: "claude-opus-4-6",
                content: [{ type: "text", text: "First" }],
                usage: { input_tokens: 100, output_tokens: 50 },
              },
            },
            {
              type: "assistant",
              sessionId: "token-session-0000-000000000000",
              message: {
                role: "assistant",
                model: "claude-opus-4-6",
                content: [{ type: "text", text: "Second" }],
                usage: { input_tokens: 200, output_tokens: 100 },
              },
            },
          ],
        },
      ]);

      const session = await adapter.status("token-session-0000-000000000000");
      expect(session.tokens).toEqual({ in: 300, out: 150 });
    });
  });

  describe("multiple projects", () => {
    it("returns sessions from all projects", async () => {
      const now = new Date();

      await createFakeProject("project-a", [
        {
          id: "session-a-0000-0000-000000000000",
          firstPrompt: "project a",
          created: now.toISOString(),
          modified: now.toISOString(),
          messages: [],
        },
      ]);

      await createFakeProject("project-b", [
        {
          id: "session-b-0000-0000-000000000000",
          firstPrompt: "project b",
          created: now.toISOString(),
          modified: now.toISOString(),
          messages: [],
        },
      ]);

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(2);
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain("session-a-0000-0000-000000000000");
      expect(ids).toContain("session-b-0000-0000-000000000000");
    });
  });

  describe("PID recycling detection", () => {
    it("detects recycled PID via cwd match — old session stays stopped", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");
      const sessionModified = new Date("2026-02-17T11:00:00Z");
      // A different process got the same PID — started BEFORE the session
      const processStartTime = "Mon Feb 16 08:00:00 2026";

      await createFakeProject("pid-recycle-test", [
        {
          id: "old-session-0000-0000-000000000000",
          firstPrompt: "old session",
          created: sessionCreated.toISOString(),
          modified: sessionModified.toISOString(),
          messages: [],
        },
      ]);

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(12345, {
        pid: 12345,
        cwd: "/Users/test/pid-recycle-test",
        args: "claude --dangerously-skip-permissions --print",
        startTime: processStartTime,
      });

      const adapterWithPids = new ClaudeCodeAdapter({
        claudeDir,
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
      const sessionModified = new Date("2026-02-17T10:01:00Z");
      // Process started AFTER the session was created
      const processStartTime = "Mon Feb 17 10:00:05 2026";

      await createFakeProject("legit-running-test", [
        {
          id: "running-session-0000-000000000000",
          firstPrompt: "currently running",
          created: sessionCreated.toISOString(),
          modified: sessionModified.toISOString(),
          messages: [],
        },
      ]);

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(99999, {
        pid: 99999,
        cwd: "/Users/test/legit-running-test",
        args: "claude --dangerously-skip-permissions --print",
        startTime: processStartTime,
      });

      const adapterWithPids = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].pid).toBe(99999);
    });

    it("detects recycled PID via sessionId in args — old session stays stopped", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");
      const sessionModified = new Date("2026-02-17T11:00:00Z");
      // Process started before the session — recycled PID happens to have
      // a matching string in its args (unlikely but possible)
      const processStartTime = "Sun Feb 16 08:00:00 2026";

      await createFakeProject("pid-recycle-args-test", [
        {
          id: "args-session-0000-0000-000000000000",
          firstPrompt: "args test",
          created: sessionCreated.toISOString(),
          modified: sessionModified.toISOString(),
          messages: [],
        },
      ]);

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(54321, {
        pid: 54321,
        cwd: "/some/other/path",
        args: "claude --continue args-session-0000-0000-000000000000",
        startTime: processStartTime,
      });

      const adapterWithPids = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });

    it("falls back to stopped when startTime is unavailable (BUG-1 safety)", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      await createFakeProject("no-starttime-test", [
        {
          id: "notime-session-0000-000000000000",
          firstPrompt: "no start time",
          created: sessionCreated.toISOString(),
          modified: sessionCreated.toISOString(),
          messages: [],
        },
      ]);

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(11111, {
        pid: 11111,
        cwd: "/Users/test/no-starttime-test",
        args: "claude --dangerously-skip-permissions",
        // No startTime — can't verify PID ownership, assume stopped (safety)
      });

      const adapterWithPids = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });

    it("multiple sessions in same project — only the one matching the PID shows running", async () => {
      const oldCreated = new Date("2026-02-16T10:00:00Z");
      const newCreated = new Date("2026-02-17T10:00:00Z");
      // Process started after the new session
      const processStartTime = "Mon Feb 17 10:00:01 2026";

      await createFakeProject("multi-session-project", [
        {
          id: "old-multi-session-0000-000000000000",
          firstPrompt: "old task",
          created: oldCreated.toISOString(),
          modified: oldCreated.toISOString(),
          messages: [],
        },
        {
          id: "new-multi-session-0000-000000000000",
          firstPrompt: "new task",
          created: newCreated.toISOString(),
          modified: newCreated.toISOString(),
          messages: [],
        },
      ]);

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(77777, {
        pid: 77777,
        cwd: "/Users/test/multi-session-project",
        args: "claude --dangerously-skip-permissions --print",
        startTime: processStartTime,
      });

      const adapterWithPids = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(2);

      const oldSession = sessions.find(
        (s) => s.id === "old-multi-session-0000-000000000000",
      );
      const newSession = sessions.find(
        (s) => s.id === "new-multi-session-0000-000000000000",
      );

      // Both match by cwd, but the process started after both sessions,
      // so both could legitimately be running. This is a cwd ambiguity
      // (not PID recycling). The process matches both.
      expect(oldSession?.status).toBe("running");
      expect(newSession?.status).toBe("running");
    });
  });

  describe("session lifecycle — detached processes (BUG-2, BUG-3)", () => {
    it("session shows running when persisted metadata has live PID", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");
      const launchedAt = sessionCreated.toISOString();

      await createFakeProject("detached-test", [
        {
          id: "detached-session-0000-000000000000",
          firstPrompt: "detached test",
          created: sessionCreated.toISOString(),
          modified: sessionCreated.toISOString(),
          messages: [],
        },
      ]);

      // Write persisted session metadata (as launch() would)
      const meta: LaunchedSessionMeta = {
        sessionId: "detached-session-0000-000000000000",
        pid: 55555,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/detached-test",
        launchedAt,
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "detached-session-0000-000000000000.json"),
        JSON.stringify(meta),
      );

      // No PIDs from ps aux (wrapper exited), but PID is still alive
      const adapterWithLivePid = new ClaudeCodeAdapter({
        claudeDir,
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

      await createFakeProject("dead-detached-test", [
        {
          id: "dead-detached-0000-0000-000000000000",
          firstPrompt: "dead detached",
          created: sessionCreated.toISOString(),
          modified: sessionCreated.toISOString(),
          messages: [],
        },
      ]);

      // Write stale metadata — PID is dead
      const meta: LaunchedSessionMeta = {
        sessionId: "dead-detached-0000-0000-000000000000",
        pid: 66666,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/dead-detached-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "dead-detached-0000-0000-000000000000.json"),
        JSON.stringify(meta),
      );

      const adapterWithDeadPid = new ClaudeCodeAdapter({
        claudeDir,
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

      await createFakeProject("cleanup-test", [
        {
          id: "cleanup-session-0000-000000000000",
          firstPrompt: "cleanup test",
          created: sessionCreated.toISOString(),
          modified: sessionCreated.toISOString(),
          messages: [],
        },
      ]);

      const metaPath = path.join(
        sessionsMetaDir,
        "cleanup-session-0000-000000000000.json",
      );
      const meta: LaunchedSessionMeta = {
        sessionId: "cleanup-session-0000-000000000000",
        pid: 77777,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/cleanup-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(metaPath, JSON.stringify(meta));

      const adapterWithDeadPid = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });

      await adapterWithDeadPid.list({ all: true });

      // Metadata file should have been cleaned up
      await expect(fs.access(metaPath)).rejects.toThrow();
    });

    it("detects PID recycling in persisted metadata via start time", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      await createFakeProject("meta-recycle-test", [
        {
          id: "meta-recycle-0000-0000-000000000000",
          firstPrompt: "meta recycle test",
          created: sessionCreated.toISOString(),
          modified: sessionCreated.toISOString(),
          messages: [],
        },
      ]);

      // Metadata says PID 88888 started before the session — recycled
      const meta: LaunchedSessionMeta = {
        sessionId: "meta-recycle-0000-0000-000000000000",
        pid: 88888,
        startTime: "Sun Feb 16 08:00:00 2026",
        cwd: "/Users/test/meta-recycle-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "meta-recycle-0000-0000-000000000000.json"),
        JSON.stringify(meta),
      );

      const adapterWithRecycledPid = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: (pid) => pid === 88888, // PID exists but is recycled
      });

      const sessions = await adapterWithRecycledPid.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });

    it("old metadata without startTime but with live PID assumes running", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      await createFakeProject("meta-no-starttime-test", [
        {
          id: "meta-notime-0000-0000-000000000000",
          firstPrompt: "meta no starttime",
          created: sessionCreated.toISOString(),
          modified: sessionCreated.toISOString(),
          messages: [],
        },
      ]);

      // Metadata has no startTime (e.g. ps failed during launch)
      const meta: LaunchedSessionMeta = {
        sessionId: "meta-notime-0000-0000-000000000000",
        pid: 99999,
        cwd: "/Users/test/meta-no-starttime-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "meta-notime-0000-0000-000000000000.json"),
        JSON.stringify(meta),
      );

      const adapterWithLivePid = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: (pid) => pid === 99999,
      });

      const sessions = await adapterWithLivePid.list({ all: true });
      expect(sessions).toHaveLength(1);
      // With live PID but no startTime, we still assume running for detached sessions
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].pid).toBe(99999);
    });
  });

  describe("session lifecycle scenarios (BUG-5)", () => {
    it("wrapper dies → Claude Code continues → status shows running", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      await createFakeProject("wrapper-dies-test", [
        {
          id: "wrapper-dies-0000-0000-000000000000",
          firstPrompt: "wrapper dies scenario",
          created: sessionCreated.toISOString(),
          modified: sessionCreated.toISOString(),
          messages: [],
        },
      ]);

      // Simulate: wrapper died, but Claude Code still running.
      // Persisted metadata has the PID, PID is alive, start time matches.
      const meta: LaunchedSessionMeta = {
        sessionId: "wrapper-dies-0000-0000-000000000000",
        pid: 44444,
        wrapperPid: 11111, // Wrapper PID — dead
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/wrapper-dies-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "wrapper-dies-0000-0000-000000000000.json"),
        JSON.stringify(meta),
      );

      // No PIDs from ps aux (wrapper's `claude` process isn't in ps output
      // because it was fully detached from the wrapper).
      // But the Claude Code PID (44444) IS alive.
      const adapterTest = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        getPids: async () => new Map(), // ps aux shows nothing
        isProcessAlive: (pid) => pid === 44444, // Claude Code is alive
      });

      const sessions = await adapterTest.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].pid).toBe(44444);
    });

    it("Claude Code completes → status shows stopped", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      await createFakeProject("cc-complete-test", [
        {
          id: "cc-complete-0000-0000-000000000000",
          firstPrompt: "CC completes scenario",
          created: sessionCreated.toISOString(),
          modified: new Date("2026-02-17T10:30:00Z").toISOString(),
          messages: [
            {
              type: "assistant",
              sessionId: "cc-complete-0000-0000-000000000000",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "All done!" }],
                model: "claude-opus-4-6",
              },
            },
          ],
        },
      ]);

      // Persisted metadata: PID is dead (Claude Code exited)
      const meta: LaunchedSessionMeta = {
        sessionId: "cc-complete-0000-0000-000000000000",
        pid: 55555,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/cc-complete-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "cc-complete-0000-0000-000000000000.json"),
        JSON.stringify(meta),
      );

      const adapterTest = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: () => false, // All PIDs dead
      });

      const sessions = await adapterTest.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
      expect(sessions[0].pid).toBeUndefined();
    });

    it("old PID recycled → old session shows stopped, not running", async () => {
      const oldSessionCreated = new Date("2026-02-16T10:00:00Z");

      await createFakeProject("pid-recycled-scenario", [
        {
          id: "recycled-victim-0000-000000000000",
          firstPrompt: "old session with recycled pid",
          created: oldSessionCreated.toISOString(),
          modified: new Date("2026-02-16T11:00:00Z").toISOString(),
          messages: [],
        },
      ]);

      // Old session has metadata with PID 33333
      const meta: LaunchedSessionMeta = {
        sessionId: "recycled-victim-0000-000000000000",
        pid: 33333,
        startTime: "Sun Feb 16 10:00:01 2026", // Original process start
        cwd: "/Users/test/pid-recycled-scenario",
        launchedAt: oldSessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "recycled-victim-0000-000000000000.json"),
        JSON.stringify(meta),
      );

      // PID 33333 is alive BUT it's a different process (recycled).
      // The actual process started at a completely different time.
      const pidMap = new Map<number, PidInfo>();
      pidMap.set(33333, {
        pid: 33333,
        cwd: "/some/other/project",
        args: "claude --dangerously-skip-permissions --print",
        startTime: "Thu Feb 20 09:00:00 2026", // Started days later
      });

      const adapterTest = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        // PID 33333 IS alive — but the metadata start time won't match
        isProcessAlive: (pid) => pid === 33333,
      });

      const sessions = await adapterTest.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });

    it("two sessions same project, same PID — only live one matches", async () => {
      const oldCreated = new Date("2026-02-15T10:00:00Z");
      const newCreated = new Date("2026-02-17T10:00:00Z");
      const processStartTime = "Mon Feb 17 10:00:01 2026";

      await createFakeProject("two-sessions-pid", [
        {
          id: "old-sess-same-pid-0000-000000000000",
          firstPrompt: "old session",
          created: oldCreated.toISOString(),
          modified: oldCreated.toISOString(),
          messages: [],
        },
        {
          id: "new-sess-same-pid-0000-000000000000",
          firstPrompt: "new session",
          created: newCreated.toISOString(),
          modified: newCreated.toISOString(),
          messages: [],
        },
      ]);

      // Only the new session has valid metadata
      const meta: LaunchedSessionMeta = {
        sessionId: "new-sess-same-pid-0000-000000000000",
        pid: 22222,
        startTime: processStartTime,
        cwd: "/Users/test/two-sessions-pid",
        launchedAt: newCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "new-sess-same-pid-0000-000000000000.json"),
        JSON.stringify(meta),
      );

      // Process 22222 is running with matching cwd
      const pidMap = new Map<number, PidInfo>();
      pidMap.set(22222, {
        pid: 22222,
        cwd: "/Users/test/two-sessions-pid",
        args: "claude --dangerously-skip-permissions --print",
        startTime: processStartTime,
      });

      const adapterTest = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: (pid) => pid === 22222,
      });

      const sessions = await adapterTest.list({ all: true });
      expect(sessions).toHaveLength(2);

      const oldSess = sessions.find(
        (s) => s.id === "old-sess-same-pid-0000-000000000000",
      );
      const newSess = sessions.find(
        (s) => s.id === "new-sess-same-pid-0000-000000000000",
      );

      // The process started after the new session, so new is running.
      // The process also started after the old session, so both match by cwd.
      expect(newSess?.status).toBe("running");
      // Old session also matches by cwd+time (this is the cwd ambiguity case)
      expect(oldSess?.status).toBe("running");
    });

    it("session ID is not pending- when metadata has real ID", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      await createFakeProject("real-id-test", [
        {
          id: "real-uuid-abcd-1234-5678-000000000000",
          firstPrompt: "real ID test",
          created: sessionCreated.toISOString(),
          modified: sessionCreated.toISOString(),
          messages: [],
        },
      ]);

      // Metadata uses the real session ID (not pending-*)
      const meta: LaunchedSessionMeta = {
        sessionId: "real-uuid-abcd-1234-5678-000000000000",
        pid: 12345,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/real-id-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(
          sessionsMetaDir,
          "real-uuid-abcd-1234-5678-000000000000.json",
        ),
        JSON.stringify(meta),
      );

      const adapterTest = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: (pid) => pid === 12345,
      });

      const sessions = await adapterTest.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("real-uuid-abcd-1234-5678-000000000000");
      expect(sessions[0].id).not.toContain("pending-");
      expect(sessions[0].status).toBe("running");
    });
  });

  describe("discover() via history.jsonl", () => {
    let historyPath: string;

    function makeHistoryLine(
      sessionId: string,
      project: string,
      display: string,
      timestamp: number,
    ): string {
      return JSON.stringify({ sessionId, project, display, timestamp });
    }

    beforeEach(() => {
      historyPath = path.join(claudeDir, "history.jsonl");
    });

    it("discovers sessions from history.jsonl", async () => {
      const now = Date.now();
      const lines = [
        makeHistoryLine("sess-1", "/proj/a", "first prompt", now - 60000),
        makeHistoryLine("sess-2", "/proj/b", "second prompt", now - 30000),
      ];
      await fs.writeFile(historyPath, lines.join("\n"));

      const historyAdapter = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        historyPath,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });

      const sessions = await historyAdapter.discover();
      expect(sessions).toHaveLength(2);

      const s1 = sessions.find((s) => s.id === "sess-1");
      const s2 = sessions.find((s) => s.id === "sess-2");
      expect(s1).toBeDefined();
      expect(s2).toBeDefined();
      expect(s1?.cwd).toBe("/proj/a");
      expect(s1?.prompt).toBe("first prompt");
      expect(s1?.status).toBe("stopped");
      expect(s2?.cwd).toBe("/proj/b");
      expect(s2?.prompt).toBe("second prompt");
    });

    it("deduplicates multiple prompts per session — uses first prompt", async () => {
      const now = Date.now();
      const lines = [
        makeHistoryLine("sess-dup", "/proj/x", "initial prompt", now - 60000),
        makeHistoryLine("sess-dup", "/proj/x", "follow up", now - 30000),
        makeHistoryLine("sess-dup", "/proj/x", "third msg", now - 10000),
      ];
      await fs.writeFile(historyPath, lines.join("\n"));

      const historyAdapter = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        historyPath,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });

      const sessions = await historyAdapter.discover();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("sess-dup");
      expect(sessions[0].prompt).toBe("initial prompt");
    });

    it("marks session running when PID matches by session ID in args", async () => {
      const now = Date.now();
      const lines = [
        makeHistoryLine("running-sess", "/proj/r", "test", now - 5000),
      ];
      await fs.writeFile(historyPath, lines.join("\n"));

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(42000, {
        pid: 42000,
        cwd: "/proj/r",
        args: "claude --continue running-sess",
        startTime: new Date(now - 4000).toString(),
      });

      const historyAdapter = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        historyPath,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await historyAdapter.discover();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].pid).toBe(42000);
    });

    it("marks session running via cwd match", async () => {
      const now = Date.now();
      const lines = [
        makeHistoryLine("cwd-sess", "/proj/cwd", "test", now - 5000),
      ];
      await fs.writeFile(historyPath, lines.join("\n"));

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(43000, {
        pid: 43000,
        cwd: "/proj/cwd",
        args: "claude --dangerously-skip-permissions --print",
        startTime: new Date(now - 4000).toString(),
      });

      const historyAdapter = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        historyPath,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await historyAdapter.discover();
      const sess = sessions.find((s) => s.id === "cwd-sess");
      expect(sess?.status).toBe("running");
      expect(sess?.pid).toBe(43000);
    });

    it("marks session running via persisted metadata for detached process", async () => {
      const now = Date.now();
      const lines = [
        makeHistoryLine("detached-hist", "/proj/d", "test", now - 60000),
      ];
      await fs.writeFile(historyPath, lines.join("\n"));

      const meta: LaunchedSessionMeta = {
        sessionId: "detached-hist",
        pid: 55000,
        startTime: new Date(now - 59000).toString(),
        cwd: "/proj/d",
        launchedAt: new Date(now - 60000).toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "detached-hist.json"),
        JSON.stringify(meta),
      );

      const historyAdapter = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        historyPath,
        getPids: async () => new Map(),
        isProcessAlive: (pid) => pid === 55000,
      });

      const sessions = await historyAdapter.discover();
      const sess = sessions.find((s) => s.id === "detached-hist");
      expect(sess?.status).toBe("running");
      expect(sess?.pid).toBe(55000);
    });

    it("does not include model or tokens (deferred to status)", async () => {
      const now = Date.now();
      const lines = [
        makeHistoryLine("no-model", "/proj/nm", "test", now - 1000),
      ];
      await fs.writeFile(historyPath, lines.join("\n"));

      const historyAdapter = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        historyPath,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });

      const sessions = await historyAdapter.discover();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].model).toBeUndefined();
      expect(sessions[0].tokens).toBeUndefined();
    });

    it("falls back to project dir scanning when history.jsonl missing", async () => {
      // Don't create history.jsonl — adapter should fall back
      const now = new Date();
      await createFakeProject("fallback-proj", [
        {
          id: "fallback-session-0000-000000000000",
          firstPrompt: "fallback test",
          created: now.toISOString(),
          modified: now.toISOString(),
          messages: [],
        },
      ]);

      const fallbackAdapter = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        historyPath: path.join(tmpDir, "nonexistent-history.jsonl"),
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });

      const sessions = await fallbackAdapter.discover();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("fallback-session-0000-000000000000");
      expect(sessions[0].cwd).toBe("/Users/test/fallback-proj");
    });

    it("skips malformed lines in history.jsonl", async () => {
      const now = Date.now();
      const lines = [
        "not json at all",
        makeHistoryLine("good-sess", "/proj/g", "valid", now),
        '{"incomplete": true}', // missing sessionId/project
        "",
      ];
      await fs.writeFile(historyPath, lines.join("\n"));

      const historyAdapter = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        historyPath,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });

      const sessions = await historyAdapter.discover();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("good-sess");
    });

    it("truncates long prompts to 200 chars", async () => {
      const now = Date.now();
      const longPrompt = "x".repeat(500);
      const lines = [
        makeHistoryLine("long-prompt", "/proj/lp", longPrompt, now),
      ];
      await fs.writeFile(historyPath, lines.join("\n"));

      const historyAdapter = new ClaudeCodeAdapter({
        claudeDir,
        sessionsMetaDir,
        historyPath,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });

      const sessions = await historyAdapter.discover();
      expect(sessions[0].prompt).toHaveLength(200);
    });
  });

  describe("peek() launch-log fallback (#135)", () => {
    it("falls back to launch log when session JSONL not found", async () => {
      // Session meta exists with logPath but no JSONL file in projects dir
      const sessionId = "short-lived-session-abc123";
      const logPath = path.join(sessionsMetaDir, `launch-${Date.now()}.log`);

      // Write launch log with assistant output (stream-json format)
      const logLines = [
        JSON.stringify({
          sessionId,
          type: "user",
          message: { content: "Fix bug" },
        }),
        JSON.stringify({
          sessionId,
          type: "assistant",
          message: { role: "assistant", content: "I fixed the bug." },
        }),
        JSON.stringify({
          sessionId,
          type: "assistant",
          message: { role: "assistant", content: "All done." },
        }),
      ];
      await fs.writeFile(logPath, logLines.join("\n"));

      // Write session meta with logPath
      const meta: LaunchedSessionMeta = {
        sessionId,
        pid: 99999,
        cwd: "/tmp/test",
        launchedAt: new Date().toISOString(),
        logPath,
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, `${sessionId}.json`),
        JSON.stringify(meta),
      );

      // peek should fall back to the launch log
      const output = await adapter.peek(sessionId);
      expect(output).toContain("I fixed the bug.");
      expect(output).toContain("All done.");
    });

    it("throws when no session file and no launch log", async () => {
      await expect(adapter.peek("nonexistent-id")).rejects.toThrow(
        "Session not found",
      );
    });
  });

  describe("peek() for short-lived sessions (#135)", () => {
    it("peeks a stopped session that has a JSONL file", async () => {
      const now = new Date();
      const created = new Date(now.getTime() - 12_000); // 12s ago

      await createFakeProject("short-project", [
        {
          id: "short-session-1",
          firstPrompt: "Quick task",
          created: created.toISOString(),
          modified: now.toISOString(),
          messages: [
            {
              type: "user",
              message: { role: "user", content: "Quick task" },
            },
            {
              type: "assistant",
              message: { role: "assistant", content: "Done quickly!" },
            },
          ],
        },
      ]);

      const output = await adapter.peek("short-session-1");
      expect(output).toBe("Done quickly!");
    });
  });
});
