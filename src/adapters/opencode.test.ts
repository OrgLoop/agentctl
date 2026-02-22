import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeProjectHash,
  type LaunchedSessionMeta,
  OpenCodeAdapter,
  type OpenCodeMessageFile,
  type OpenCodeSessionFile,
  type PidInfo,
} from "./opencode.js";

let tmpDir: string;
let storageDir: string;
let sessionDir: string;
let messageDir: string;
let partDir: string;
let sessionsMetaDir: string;
let adapter: OpenCodeAdapter;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-opencode-test-"));
  storageDir = path.join(tmpDir, "storage");
  sessionDir = path.join(storageDir, "session");
  messageDir = path.join(storageDir, "message");
  partDir = path.join(storageDir, "part");
  sessionsMetaDir = path.join(tmpDir, "opencode-sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(messageDir, { recursive: true });
  await fs.mkdir(partDir, { recursive: true });
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

// --- Helper to create fake OpenCode session data ---

async function createFakeSession(
  directory: string,
  session: OpenCodeSessionFile,
  messages: OpenCodeMessageFile[] = [],
  parts: Record<string, Array<{ file: string; content: string }>> = {},
) {
  const projHash = computeProjectHash(directory);
  const projDir = path.join(sessionDir, projHash);
  await fs.mkdir(projDir, { recursive: true });

  // Write session file
  await fs.writeFile(
    path.join(projDir, `${session.id}.json`),
    JSON.stringify(session),
  );

  // Write message files
  if (messages.length > 0) {
    const msgDir = path.join(messageDir, session.id);
    await fs.mkdir(msgDir, { recursive: true });
    for (const msg of messages) {
      await fs.writeFile(
        path.join(msgDir, `${msg.id}.json`),
        JSON.stringify(msg),
      );
    }
  }

  // Write part files
  for (const [messageId, fileParts] of Object.entries(parts)) {
    const partMsgDir = path.join(partDir, messageId);
    await fs.mkdir(partMsgDir, { recursive: true });
    for (const p of fileParts) {
      await fs.writeFile(path.join(partMsgDir, p.file), p.content);
    }
  }
}

function makeSession(
  overrides: Partial<OpenCodeSessionFile> = {},
): OpenCodeSessionFile {
  const now = new Date();
  return {
    id: overrides.id || "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    slug: overrides.slug || "test-session",
    version: overrides.version || "1.0.0",
    projectID: overrides.projectID || "proj-hash-123",
    directory: overrides.directory || "/Users/test/my-project",
    title: overrides.title || "Test session",
    time: overrides.time || {
      created: new Date(now.getTime() - 3600_000).toISOString(),
      updated: now.toISOString(),
    },
    summary: overrides.summary || { additions: 10, deletions: 5, files: 3 },
  };
}

function makeMessage(
  overrides: Partial<OpenCodeMessageFile> = {},
): OpenCodeMessageFile {
  return {
    id: overrides.id || "msg-001",
    sessionID: overrides.sessionID || "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    role: overrides.role || "assistant",
    time: overrides.time || {
      created: new Date().toISOString(),
      completed: new Date().toISOString(),
    },
    agent: overrides.agent || "default",
    model: overrides.model || {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5-20250929",
    },
    tokens: overrides.tokens || { input: 100, output: 50, reasoning: 0 },
    cache: overrides.cache || { read: 0, write: 0 },
    cost: overrides.cost ?? 0.003,
    finish: overrides.finish || "end_turn",
  };
}

// --- Tests ---

describe("OpenCodeAdapter", () => {
  it("has correct id", () => {
    expect(adapter.id).toBe("opencode");
  });

  describe("computeProjectHash()", () => {
    it("computes SHA1 hash of directory path", () => {
      const hash = computeProjectHash("/Users/test/my-project");
      expect(hash).toMatch(/^[0-9a-f]{40}$/);
    });

    it("returns different hashes for different paths", () => {
      const hash1 = computeProjectHash("/Users/test/project-a");
      const hash2 = computeProjectHash("/Users/test/project-b");
      expect(hash1).not.toBe(hash2);
    });

    it("returns same hash for same path", () => {
      const hash1 = computeProjectHash("/Users/test/my-project");
      const hash2 = computeProjectHash("/Users/test/my-project");
      expect(hash1).toBe(hash2);
    });
  });

  describe("list()", () => {
    it("returns empty array when no sessions exist", async () => {
      const sessions = await adapter.list({ all: true });
      expect(sessions).toEqual([]);
    });

    it("returns empty array when session dir does not exist", async () => {
      const emptyAdapter = new OpenCodeAdapter({
        storageDir: path.join(tmpDir, "nonexistent"),
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });
      const sessions = await emptyAdapter.list({ all: true });
      expect(sessions).toEqual([]);
    });

    it("returns stopped sessions with --all", async () => {
      const session = makeSession();
      const msg = makeMessage({
        model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      });

      await createFakeSession(session.directory || "", session, [msg]);

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect(sessions[0].status).toBe("stopped");
      expect(sessions[0].model).toBe("claude-opus-4-6");
      expect(sessions[0].adapter).toBe("opencode");
    });

    it("filters by status", async () => {
      const session = makeSession();
      await createFakeSession(session.directory || "", session);

      const running = await adapter.list({ status: "running" });
      expect(running).toHaveLength(0);

      const stopped = await adapter.list({ status: "stopped" });
      expect(stopped).toHaveLength(1);
    });

    it("default list (no opts) only shows running sessions", async () => {
      const session = makeSession();
      await createFakeSession(session.directory || "", session);

      const sessions = await adapter.list();
      expect(sessions).toHaveLength(0);
    });

    it("skips old stopped sessions when not using --all", async () => {
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
      const session = makeSession({
        time: {
          created: oldDate.toISOString(),
          updated: oldDate.toISOString(),
        },
      });

      await createFakeSession(session.directory || "", session);

      // With --all, old sessions are included
      const withAll = await adapter.list({ all: true });
      expect(withAll).toHaveLength(1);

      // With status filter but no --all, old stopped sessions are still skipped
      const withStatusFilter = await adapter.list({ status: "stopped" });
      expect(withStatusFilter).toHaveLength(0);

      // Default list also skips them
      const defaultList = await adapter.list();
      expect(defaultList).toHaveLength(0);
    });

    it("returns sessions from multiple projects", async () => {
      const session1 = makeSession({
        id: "session-a-0000-0000-000000000001",
        directory: "/Users/test/project-a",
        title: "Project A session",
      });
      const session2 = makeSession({
        id: "session-b-0000-0000-000000000002",
        directory: "/Users/test/project-b",
        title: "Project B session",
      });

      await createFakeSession("/Users/test/project-a", session1);
      await createFakeSession("/Users/test/project-b", session2);

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(2);
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain("session-a-0000-0000-000000000001");
      expect(ids).toContain("session-b-0000-0000-000000000002");
    });

    it("returns sessions sorted running first then by most recent", async () => {
      const old = new Date("2026-02-15T10:00:00Z");
      const recent = new Date("2026-02-20T10:00:00Z");

      const oldSession = makeSession({
        id: "old-session-0000-0000-000000000000",
        directory: "/Users/test/project",
        time: { created: old.toISOString(), updated: old.toISOString() },
      });
      const recentSession = makeSession({
        id: "recent-session-0000-000000000000",
        directory: "/Users/test/project",
        time: {
          created: recent.toISOString(),
          updated: recent.toISOString(),
        },
      });

      await createFakeSession("/Users/test/project", oldSession);
      // Need a different project hash for the second session
      await createFakeSession("/Users/test/project2", {
        ...recentSession,
        directory: "/Users/test/project2",
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(2);
      // More recent should come first
      expect(sessions[0].id).toBe("recent-session-0000-000000000000");
    });

    it("populates session metadata correctly", async () => {
      const session = makeSession({
        slug: "my-slug",
        version: "2.0.0",
        summary: { additions: 25, deletions: 10, files: 5 },
      });
      await createFakeSession(session.directory || "", session);

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].meta.slug).toBe("my-slug");
      expect(sessions[0].meta.version).toBe("2.0.0");
      expect(sessions[0].meta.summary).toEqual({
        additions: 25,
        deletions: 10,
        files: 5,
      });
    });

    it("skips malformed session files", async () => {
      const projHash = computeProjectHash("/Users/test/bad-project");
      const projDir = path.join(sessionDir, projHash);
      await fs.mkdir(projDir, { recursive: true });

      // Write a malformed JSON file
      await fs.writeFile(path.join(projDir, "bad-session.json"), "not json{{{");

      // Write a valid session alongside
      const good = makeSession({ directory: "/Users/test/bad-project" });
      await fs.writeFile(
        path.join(projDir, `${good.id}.json`),
        JSON.stringify(good),
      );

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(good.id);
    });

    it("skips non-directory entries in session dir", async () => {
      // Write a file (not directory) in the session dir
      await fs.writeFile(path.join(sessionDir, "not-a-dir.txt"), "hello");

      const session = makeSession();
      await createFakeSession(session.directory || "", session);

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
    });
  });

  describe("peek()", () => {
    it("returns recent assistant messages from parts", async () => {
      const session = makeSession();
      const msg1 = makeMessage({ id: "msg-user-001", role: "user" });
      const msg2 = makeMessage({
        id: "msg-asst-001",
        role: "assistant",
        time: {
          created: "2026-02-20T10:01:00Z",
          completed: "2026-02-20T10:01:30Z",
        },
      });
      const msg3 = makeMessage({
        id: "msg-asst-002",
        role: "assistant",
        time: {
          created: "2026-02-20T10:02:00Z",
          completed: "2026-02-20T10:02:30Z",
        },
      });

      await createFakeSession(
        session.directory || "",
        session,
        [msg1, msg2, msg3],
        {
          "msg-asst-001": [
            {
              file: "part-001.json",
              content: JSON.stringify({ text: "First assistant response." }),
            },
          ],
          "msg-asst-002": [
            {
              file: "part-001.json",
              content: JSON.stringify({ text: "Second assistant response." }),
            },
          ],
        },
      );

      const output = await adapter.peek(session.id);
      expect(output).toContain("First assistant response.");
      expect(output).toContain("Second assistant response.");
    });

    it("respects line limit", async () => {
      const session = makeSession();
      const messages: OpenCodeMessageFile[] = [];
      const parts: Record<
        string,
        Array<{ file: string; content: string }>
      > = {};

      for (let i = 0; i < 10; i++) {
        const msgId = `msg-asst-${i.toString().padStart(3, "0")}`;
        messages.push(
          makeMessage({
            id: msgId,
            role: "assistant",
            time: {
              created: new Date(Date.now() + i * 1000).toISOString(),
              completed: new Date(Date.now() + i * 1000 + 500).toISOString(),
            },
          }),
        );
        parts[msgId] = [
          {
            file: "part-001.json",
            content: JSON.stringify({ text: `Message ${i}` }),
          },
        ];
      }

      await createFakeSession(
        session.directory || "",
        session,
        messages,
        parts,
      );

      const output = await adapter.peek(session.id, { lines: 3 });
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
      const session = makeSession({
        id: "abcdef12-3456-7890-abcd-ef1234567890",
      });
      const msg = makeMessage({ id: "msg-prefix-001", role: "assistant" });

      await createFakeSession(session.directory || "", session, [msg], {
        "msg-prefix-001": [
          {
            file: "part-001.json",
            content: JSON.stringify({ text: "Found by prefix!" }),
          },
        ],
      });

      const output = await adapter.peek("abcdef12");
      expect(output).toContain("Found by prefix!");
    });

    it("handles sessions with no messages", async () => {
      const session = makeSession();
      await createFakeSession(session.directory || "", session);

      const output = await adapter.peek(session.id);
      expect(output).toBe("");
    });

    it("handles messages with no parts", async () => {
      const session = makeSession();
      const msg = makeMessage({ id: "msg-no-parts", role: "assistant" });

      await createFakeSession(session.directory || "", session, [msg]);

      const output = await adapter.peek(session.id);
      // No parts dir exists — should return empty for this message
      expect(output).toBe("");
    });

    it("handles raw text parts (non-JSON)", async () => {
      const session = makeSession();
      const msg = makeMessage({ id: "msg-raw-001", role: "assistant" });

      await createFakeSession(session.directory || "", session, [msg], {
        "msg-raw-001": [
          { file: "part-001.txt", content: "Raw text content here" },
        ],
      });

      const output = await adapter.peek(session.id);
      expect(output).toContain("Raw text content here");
    });

    it("handles parts with 'content' field", async () => {
      const session = makeSession();
      const msg = makeMessage({ id: "msg-content-001", role: "assistant" });

      await createFakeSession(session.directory || "", session, [msg], {
        "msg-content-001": [
          {
            file: "part-001.json",
            content: JSON.stringify({ content: "Content field text" }),
          },
        ],
      });

      const output = await adapter.peek(session.id);
      expect(output).toContain("Content field text");
    });
  });

  describe("status()", () => {
    it("returns session details", async () => {
      const session = makeSession({
        title: "Status check session",
      });
      const msg = makeMessage({
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5-20250929",
        },
        tokens: { input: 500, output: 200, reasoning: 0 },
        cost: 0.01,
      });

      await createFakeSession(session.directory || "", session, [msg]);

      const result = await adapter.status(session.id);
      expect(result.id).toBe(session.id);
      expect(result.adapter).toBe("opencode");
      expect(result.status).toBe("stopped");
      expect(result.model).toBe("claude-sonnet-4-5-20250929");
      expect(result.tokens).toEqual({ in: 500, out: 200 });
      expect(result.cost).toBe(0.01);
      expect(result.cwd).toBe("/Users/test/my-project");
      expect(result.prompt).toBe("Status check session");
    });

    it("throws for unknown session", async () => {
      await expect(adapter.status("nonexistent")).rejects.toThrow(
        "Session not found",
      );
    });

    it("supports prefix matching", async () => {
      const session = makeSession({
        id: "abcdef99-1111-2222-3333-444444444444",
      });
      await createFakeSession(session.directory || "", session);

      const result = await adapter.status("abcdef99");
      expect(result.id).toBe("abcdef99-1111-2222-3333-444444444444");
    });
  });

  describe("token aggregation", () => {
    it("sums tokens across multiple assistant messages", async () => {
      const session = makeSession();
      const msg1 = makeMessage({
        id: "msg-tok-001",
        tokens: { input: 100, output: 50, reasoning: 10 },
        cost: 0.005,
      });
      const msg2 = makeMessage({
        id: "msg-tok-002",
        tokens: { input: 200, output: 100, reasoning: 20 },
        cost: 0.01,
      });

      await createFakeSession(session.directory || "", session, [msg1, msg2]);

      const result = await adapter.status(session.id);
      expect(result.tokens).toEqual({ in: 300, out: 150 });
      expect(result.cost).toBe(0.015);
    });

    it("returns undefined tokens when no messages have token data", async () => {
      const session = makeSession();
      // Create a message with explicitly zero/undefined tokens
      const msgDir = path.join(messageDir, session.id);
      await fs.mkdir(msgDir, { recursive: true });
      await fs.writeFile(
        path.join(msgDir, "msg-notok-001.json"),
        JSON.stringify({
          id: "msg-notok-001",
          sessionID: session.id,
          role: "assistant",
          time: { created: new Date().toISOString() },
        }),
      );

      await createFakeSession(session.directory || "", session);

      const result = await adapter.status(session.id);
      expect(result.tokens).toBeUndefined();
      expect(result.cost).toBeUndefined();
    });

    it("uses last assistant model as session model", async () => {
      const session = makeSession();
      const msg1 = makeMessage({
        id: "msg-model-001",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5-20250929",
        },
        time: {
          created: "2026-02-20T10:00:00Z",
          completed: "2026-02-20T10:00:30Z",
        },
      });
      const msg2 = makeMessage({
        id: "msg-model-002",
        model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
        time: {
          created: "2026-02-20T10:01:00Z",
          completed: "2026-02-20T10:01:30Z",
        },
      });

      await createFakeSession(session.directory || "", session, [msg1, msg2]);

      const result = await adapter.status(session.id);
      expect(result.model).toBe("claude-opus-4-6");
    });

    it("ignores user messages for token aggregation", async () => {
      const session = makeSession();
      const userMsg = makeMessage({
        id: "msg-user-tok-001",
        role: "user",
        tokens: { input: 500, output: 0, reasoning: 0 },
        cost: 0,
      });
      const assistantMsg = makeMessage({
        id: "msg-asst-tok-001",
        role: "assistant",
        tokens: { input: 100, output: 50, reasoning: 0 },
        cost: 0.003,
      });

      await createFakeSession(session.directory || "", session, [
        userMsg,
        assistantMsg,
      ]);

      const result = await adapter.status(session.id);
      expect(result.tokens).toEqual({ in: 100, out: 50 });
    });
  });

  describe("PID recycling detection", () => {
    it("detects recycled PID via cwd match — old session stays stopped", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");
      const sessionModified = new Date("2026-02-17T11:00:00Z");
      const processStartTime = "Mon Feb 16 08:00:00 2026"; // Before session

      const session = makeSession({
        directory: "/Users/test/pid-recycle-test",
        time: {
          created: sessionCreated.toISOString(),
          updated: sessionModified.toISOString(),
        },
      });

      await createFakeSession("/Users/test/pid-recycle-test", session);

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(12345, {
        pid: 12345,
        cwd: "/Users/test/pid-recycle-test",
        args: "opencode run test",
        startTime: processStartTime,
      });

      const adapterWithPids = new OpenCodeAdapter({
        storageDir,
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
      const processStartTime = "Mon Feb 17 10:00:05 2026"; // After session

      const session = makeSession({
        directory: "/Users/test/legit-running",
        time: {
          created: sessionCreated.toISOString(),
          updated: sessionModified.toISOString(),
        },
      });

      await createFakeSession("/Users/test/legit-running", session);

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(99999, {
        pid: 99999,
        cwd: "/Users/test/legit-running",
        args: "opencode run implement feature",
        startTime: processStartTime,
      });

      const adapterWithPids = new OpenCodeAdapter({
        storageDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].pid).toBe(99999);
    });

    it("falls back to stopped when startTime is unavailable", async () => {
      const session = makeSession({
        directory: "/Users/test/no-starttime",
        time: {
          created: new Date("2026-02-17T10:00:00Z").toISOString(),
          updated: new Date("2026-02-17T10:00:00Z").toISOString(),
        },
      });

      await createFakeSession("/Users/test/no-starttime", session);

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(11111, {
        pid: 11111,
        cwd: "/Users/test/no-starttime",
        args: "opencode run test",
        // No startTime
      });

      const adapterWithPids = new OpenCodeAdapter({
        storageDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });

    it("multiple sessions in same project — process started after both shows both running", async () => {
      const oldCreated = new Date("2026-02-16T10:00:00Z");
      const newCreated = new Date("2026-02-17T10:00:00Z");
      const processStartTime = "Mon Feb 17 10:00:01 2026";

      const oldSession = makeSession({
        id: "old-session-0000-0000-000000000000",
        directory: "/Users/test/multi-session",
        time: {
          created: oldCreated.toISOString(),
          updated: oldCreated.toISOString(),
        },
      });
      const newSession = makeSession({
        id: "new-session-0000-0000-000000000000",
        directory: "/Users/test/multi-session",
        time: {
          created: newCreated.toISOString(),
          updated: newCreated.toISOString(),
        },
      });

      // Both sessions go in the same project hash directory
      const projHash = computeProjectHash("/Users/test/multi-session");
      const projDir = path.join(sessionDir, projHash);
      await fs.mkdir(projDir, { recursive: true });
      await fs.writeFile(
        path.join(projDir, `${oldSession.id}.json`),
        JSON.stringify(oldSession),
      );
      await fs.writeFile(
        path.join(projDir, `${newSession.id}.json`),
        JSON.stringify(newSession),
      );

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(77777, {
        pid: 77777,
        cwd: "/Users/test/multi-session",
        args: "opencode run test",
        startTime: processStartTime,
      });

      const adapterWithPids = new OpenCodeAdapter({
        storageDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(2);

      const oldSess = sessions.find(
        (s) => s.id === "old-session-0000-0000-000000000000",
      );
      const newSess = sessions.find(
        (s) => s.id === "new-session-0000-0000-000000000000",
      );

      // Both match by cwd — process started after both
      expect(oldSess?.status).toBe("running");
      expect(newSess?.status).toBe("running");
    });
  });

  describe("session lifecycle — detached processes", () => {
    it("session shows running when persisted metadata has live PID", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      const session = makeSession({
        directory: "/Users/test/detached-test",
        time: {
          created: sessionCreated.toISOString(),
          updated: sessionCreated.toISOString(),
        },
      });

      await createFakeSession("/Users/test/detached-test", session);

      const meta: LaunchedSessionMeta = {
        sessionId: session.id,
        pid: 55555,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/detached-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, `${session.id}.json`),
        JSON.stringify(meta),
      );

      const adapterWithLivePid = new OpenCodeAdapter({
        storageDir,
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

      const session = makeSession({
        directory: "/Users/test/dead-detached",
        time: {
          created: sessionCreated.toISOString(),
          updated: sessionCreated.toISOString(),
        },
      });

      await createFakeSession("/Users/test/dead-detached", session);

      const meta: LaunchedSessionMeta = {
        sessionId: session.id,
        pid: 66666,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/dead-detached",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, `${session.id}.json`),
        JSON.stringify(meta),
      );

      const adapterWithDeadPid = new OpenCodeAdapter({
        storageDir,
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

      const session = makeSession({
        directory: "/Users/test/cleanup-test",
        time: {
          created: sessionCreated.toISOString(),
          updated: sessionCreated.toISOString(),
        },
      });

      await createFakeSession("/Users/test/cleanup-test", session);

      const metaPath = path.join(sessionsMetaDir, `${session.id}.json`);
      const meta: LaunchedSessionMeta = {
        sessionId: session.id,
        pid: 77777,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/cleanup-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(metaPath, JSON.stringify(meta));

      const adapterWithDeadPid = new OpenCodeAdapter({
        storageDir,
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

      const session = makeSession({
        directory: "/Users/test/meta-recycle",
        time: {
          created: sessionCreated.toISOString(),
          updated: sessionCreated.toISOString(),
        },
      });

      await createFakeSession("/Users/test/meta-recycle", session);

      const meta: LaunchedSessionMeta = {
        sessionId: session.id,
        pid: 88888,
        startTime: "Sun Feb 16 08:00:00 2026", // Before session — recycled
        cwd: "/Users/test/meta-recycle",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, `${session.id}.json`),
        JSON.stringify(meta),
      );

      const adapterWithRecycledPid = new OpenCodeAdapter({
        storageDir,
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

      const session = makeSession({
        directory: "/Users/test/no-starttime-meta",
        time: {
          created: sessionCreated.toISOString(),
          updated: sessionCreated.toISOString(),
        },
      });

      await createFakeSession("/Users/test/no-starttime-meta", session);

      const meta: LaunchedSessionMeta = {
        sessionId: session.id,
        pid: 99999,
        cwd: "/Users/test/no-starttime-meta",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, `${session.id}.json`),
        JSON.stringify(meta),
      );

      const adapterWithLivePid = new OpenCodeAdapter({
        storageDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: (pid) => pid === 99999,
      });

      const sessions = await adapterWithLivePid.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].pid).toBe(99999);
    });

    it("wrapper dies → opencode continues → status shows running", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      const session = makeSession({
        directory: "/Users/test/wrapper-dies",
        time: {
          created: sessionCreated.toISOString(),
          updated: sessionCreated.toISOString(),
        },
      });

      await createFakeSession("/Users/test/wrapper-dies", session);

      const meta: LaunchedSessionMeta = {
        sessionId: session.id,
        pid: 44444,
        wrapperPid: 11111,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/wrapper-dies",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, `${session.id}.json`),
        JSON.stringify(meta),
      );

      const adapterTest = new OpenCodeAdapter({
        storageDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: (pid) => pid === 44444,
      });

      const sessions = await adapterTest.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].pid).toBe(44444);
    });

    it("opencode completes → status shows stopped", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");

      const session = makeSession({
        directory: "/Users/test/complete-test",
        time: {
          created: sessionCreated.toISOString(),
          updated: new Date("2026-02-17T10:30:00Z").toISOString(),
        },
      });

      const msg = makeMessage({
        id: "msg-complete-001",
        role: "assistant",
        model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      });

      await createFakeSession("/Users/test/complete-test", session, [msg]);

      const meta: LaunchedSessionMeta = {
        sessionId: session.id,
        pid: 55555,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/complete-test",
        launchedAt: sessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, `${session.id}.json`),
        JSON.stringify(meta),
      );

      const adapterTest = new OpenCodeAdapter({
        storageDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });

      const sessions = await adapterTest.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
      expect(sessions[0].pid).toBeUndefined();
    });

    it("old PID recycled → old session shows stopped, not running", async () => {
      const oldSessionCreated = new Date("2026-02-16T10:00:00Z");

      const session = makeSession({
        directory: "/Users/test/pid-recycled",
        time: {
          created: oldSessionCreated.toISOString(),
          updated: new Date("2026-02-16T11:00:00Z").toISOString(),
        },
      });

      await createFakeSession("/Users/test/pid-recycled", session);

      const meta: LaunchedSessionMeta = {
        sessionId: session.id,
        pid: 33333,
        startTime: "Sun Feb 16 10:00:01 2026",
        cwd: "/Users/test/pid-recycled",
        launchedAt: oldSessionCreated.toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, `${session.id}.json`),
        JSON.stringify(meta),
      );

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(33333, {
        pid: 33333,
        cwd: "/some/other/project",
        args: "opencode run something",
        startTime: "Thu Feb 20 09:00:00 2026", // Started days later — recycled
      });

      const adapterTest = new OpenCodeAdapter({
        storageDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: (pid) => pid === 33333,
      });

      const sessions = await adapterTest.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });
  });

  describe("message reading", () => {
    it("sorts messages by creation time", async () => {
      const session = makeSession();
      const msg1 = makeMessage({
        id: "msg-sort-003",
        role: "assistant",
        time: {
          created: "2026-02-20T10:03:00Z",
          completed: "2026-02-20T10:03:30Z",
        },
      });
      const msg2 = makeMessage({
        id: "msg-sort-001",
        role: "assistant",
        time: {
          created: "2026-02-20T10:01:00Z",
          completed: "2026-02-20T10:01:30Z",
        },
      });
      const msg3 = makeMessage({
        id: "msg-sort-002",
        role: "assistant",
        time: {
          created: "2026-02-20T10:02:00Z",
          completed: "2026-02-20T10:02:30Z",
        },
      });

      await createFakeSession(
        session.directory || "",
        session,
        [msg1, msg2, msg3],
        {
          "msg-sort-001": [
            {
              file: "part-001.json",
              content: JSON.stringify({ text: "First" }),
            },
          ],
          "msg-sort-002": [
            {
              file: "part-001.json",
              content: JSON.stringify({ text: "Second" }),
            },
          ],
          "msg-sort-003": [
            {
              file: "part-001.json",
              content: JSON.stringify({ text: "Third" }),
            },
          ],
        },
      );

      const output = await adapter.peek(session.id);
      const parts = output.split("\n---\n");
      expect(parts[0]).toBe("First");
      expect(parts[1]).toBe("Second");
      expect(parts[2]).toBe("Third");
    });

    it("handles malformed message files gracefully", async () => {
      const session = makeSession();

      // Manually create message dir with a malformed file
      const msgDir = path.join(messageDir, session.id);
      await fs.mkdir(msgDir, { recursive: true });
      await fs.writeFile(path.join(msgDir, "bad-msg.json"), "not json{{{");
      await fs.writeFile(
        path.join(msgDir, "good-msg.json"),
        JSON.stringify(
          makeMessage({
            id: "good-msg",
            role: "assistant",
            tokens: { input: 50, output: 25, reasoning: 0 },
          }),
        ),
      );

      await createFakeSession(session.directory || "", session);

      const result = await adapter.status(session.id);
      expect(result.tokens).toEqual({ in: 50, out: 25 });
    });

    it("handles empty message directory", async () => {
      const session = makeSession();
      const msgDir = path.join(messageDir, session.id);
      await fs.mkdir(msgDir, { recursive: true });

      await createFakeSession(session.directory || "", session);

      const result = await adapter.status(session.id);
      expect(result.tokens).toBeUndefined();
      expect(result.model).toBeUndefined();
    });
  });

  describe("session cwd and directory", () => {
    it("uses session directory as cwd", async () => {
      const session = makeSession({
        directory: "/Users/test/specific-project",
      });
      await createFakeSession("/Users/test/specific-project", session);

      const result = await adapter.status(session.id);
      expect(result.cwd).toBe("/Users/test/specific-project");
    });

    it("handles missing directory gracefully", async () => {
      // Write session JSON directly without using makeSession defaults
      const sessionId = "no-dir-session-0000-000000000000";
      const projHash = computeProjectHash("/Users/test/fallback");
      const projDir = path.join(sessionDir, projHash);
      await fs.mkdir(projDir, { recursive: true });
      await fs.writeFile(
        path.join(projDir, `${sessionId}.json`),
        JSON.stringify({
          id: sessionId,
          title: "No directory session",
          time: {
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
          },
        }),
      );

      const result = await adapter.status(sessionId);
      expect(result.cwd).toBeUndefined();
    });
  });

  describe("cost tracking", () => {
    it("sums cost across multiple messages", async () => {
      const session = makeSession();
      const msg1 = makeMessage({ id: "msg-cost-001", cost: 0.005 });
      const msg2 = makeMessage({ id: "msg-cost-002", cost: 0.01 });
      const msg3 = makeMessage({ id: "msg-cost-003", cost: 0.003 });

      await createFakeSession(session.directory || "", session, [
        msg1,
        msg2,
        msg3,
      ]);

      const result = await adapter.status(session.id);
      expect(result.cost).toBeCloseTo(0.018);
    });

    it("returns undefined cost when messages have no cost", async () => {
      const session = makeSession();
      const msg = makeMessage({ id: "msg-nocost-001", cost: 0 });

      await createFakeSession(session.directory || "", session, [msg]);

      const result = await adapter.status(session.id);
      expect(result.cost).toBeUndefined();
    });
  });

  describe("session title as prompt", () => {
    it("uses session title as prompt", async () => {
      const session = makeSession({ title: "Fix the authentication bug" });
      await createFakeSession(session.directory || "", session);

      const result = await adapter.status(session.id);
      expect(result.prompt).toBe("Fix the authentication bug");
    });

    it("truncates long titles", async () => {
      const longTitle = "A".repeat(300);
      const session = makeSession({ title: longTitle });
      await createFakeSession(session.directory || "", session);

      const result = await adapter.status(session.id);
      expect(result.prompt).toHaveLength(200);
    });

    it("handles missing title", async () => {
      const sessionId = "no-title-session-0000-000000000000";
      const dir = "/Users/test/no-title";
      const projHash = computeProjectHash(dir);
      const projDir = path.join(sessionDir, projHash);
      await fs.mkdir(projDir, { recursive: true });
      await fs.writeFile(
        path.join(projDir, `${sessionId}.json`),
        JSON.stringify({
          id: sessionId,
          directory: dir,
          time: {
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
          },
        }),
      );

      const result = await adapter.status(sessionId);
      expect(result.prompt).toBeUndefined();
    });
  });

  describe("project hash directory structure", () => {
    it("stores sessions under SHA1 hash of directory", async () => {
      const dir = "/Users/test/my-project";
      const session = makeSession({ directory: dir });
      await createFakeSession(dir, session);

      const expectedHash = computeProjectHash(dir);
      const projDir = path.join(sessionDir, expectedHash);

      // Verify the file exists at the expected location
      const files = await fs.readdir(projDir);
      expect(files).toContain(`${session.id}.json`);
    });

    it("separates sessions from different projects", async () => {
      const session1 = makeSession({
        id: "proj-a-session-0000-000000000000",
        directory: "/Users/test/project-alpha",
      });
      const session2 = makeSession({
        id: "proj-b-session-0000-000000000000",
        directory: "/Users/test/project-beta",
      });

      await createFakeSession("/Users/test/project-alpha", session1);
      await createFakeSession("/Users/test/project-beta", session2);

      const hash1 = computeProjectHash("/Users/test/project-alpha");
      const hash2 = computeProjectHash("/Users/test/project-beta");
      expect(hash1).not.toBe(hash2);

      const files1 = await fs.readdir(path.join(sessionDir, hash1));
      const files2 = await fs.readdir(path.join(sessionDir, hash2));
      expect(files1).toContain("proj-a-session-0000-000000000000.json");
      expect(files2).toContain("proj-b-session-0000-000000000000.json");
    });
  });
});
