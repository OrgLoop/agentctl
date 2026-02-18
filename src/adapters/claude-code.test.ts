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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ctl-test-"));
  claudeDir = path.join(tmpDir, ".claude");
  projectsDir = path.join(claudeDir, "projects");
  sessionsMetaDir = path.join(claudeDir, "agent-ctl", "sessions");
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
});
