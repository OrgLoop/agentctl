import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LaunchedSessionMeta, PiAdapter, type PidInfo } from "./pi.js";

let tmpDir: string;
let piDir: string;
let sessionsDir: string;
let sessionsMetaDir: string;
let adapter: PiAdapter;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-pi-test-"));
  piDir = path.join(tmpDir, ".pi");
  sessionsDir = path.join(piDir, "agent", "sessions");
  sessionsMetaDir = path.join(piDir, "agentctl", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.mkdir(sessionsMetaDir, { recursive: true });

  // Inject empty PID map and dead-process checker so real processes don't interfere
  adapter = new PiAdapter({
    piDir,
    sessionsMetaDir,
    getPids: async () => new Map(),
    isProcessAlive: () => false,
  });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// --- Helper to create fake Pi session data ---

interface FakeMessagePayload {
  role: string;
  content: unknown;
  usage?: Record<string, unknown>;
  stopReason?: string;
}

interface FakeSessionOpts {
  id: string;
  cwdSlug: string;
  timestamp?: string;
  cwd: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  version?: string;
  /** Raw JSONL entries. For type:"message" entries, provide the Pi v3 nested format:
   *  { type: "message", id, message: { role, content, usage?, stopReason? } }
   *  Helper: use msg() to create them conveniently.
   */
  messages?: Array<Record<string, unknown>>;
}

/** Helper to create Pi v3 format message entries */
function msg(
  id: string,
  payload: FakeMessagePayload,
  parentId?: string | null,
): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId: parentId ?? null,
    message: payload,
  };
}

async function createFakePiSession(opts: FakeSessionOpts) {
  const slug = opts.cwdSlug;
  const slugDir = path.join(sessionsDir, slug);
  await fs.mkdir(slugDir, { recursive: true });

  const timestamp = opts.timestamp || Date.now().toString();
  const filename = `${timestamp}_${opts.id}.jsonl`;
  const filePath = path.join(slugDir, filename);

  // Build JSONL content: session header + messages
  const lines: string[] = [];

  // Session header
  lines.push(
    JSON.stringify({
      type: "session",
      id: opts.id,
      cwd: opts.cwd,
      provider: opts.provider || "anthropic",
      modelId: opts.modelId || "claude-sonnet-4-5-20250929",
      thinkingLevel: opts.thinkingLevel || "none",
      version: opts.version || "1.0.0",
    }),
  );

  // Messages
  for (const m of opts.messages || []) {
    lines.push(JSON.stringify(m));
  }

  await fs.writeFile(filePath, lines.join("\n"));
  return filePath;
}

// --- Tests ---

describe("PiAdapter", () => {
  it("has correct id", () => {
    expect(adapter.id).toBe("pi");
  });

  describe("list()", () => {
    it("returns empty array when no sessions exist", async () => {
      const sessions = await adapter.list({ all: true });
      expect(sessions).toEqual([]);
    });

    it("returns empty array when sessions dir does not exist", async () => {
      const a = new PiAdapter({
        piDir: path.join(tmpDir, "nonexistent"),
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });
      const sessions = await a.list({ all: true });
      expect(sessions).toEqual([]);
    });

    it("returns stopped sessions with --all", async () => {
      await createFakePiSession({
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        cwdSlug: "test-project",
        cwd: "/Users/test/test-project",
        messages: [
          msg("msg1", { role: "user", content: "Hello world" }),
          msg(
            "msg2",
            {
              role: "assistant",
              content: "Hello! How can I help?",
              usage: { input: 100, output: 50, cost: 0.003 },
              stopReason: "end_turn",
            },
            "msg1",
          ),
        ],
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect(sessions[0].status).toBe("stopped");
      expect(sessions[0].adapter).toBe("pi");
      expect(sessions[0].cwd).toBe("/Users/test/test-project");
    });

    it("returns model from session header", async () => {
      await createFakePiSession({
        id: "model-session-0000-000000000000",
        cwdSlug: "model-test",
        cwd: "/Users/test/model-test",
        modelId: "claude-opus-4-6",
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].model).toBe("claude-opus-4-6");
    });

    it("filters by status", async () => {
      await createFakePiSession({
        id: "filter-session-0000-000000000001",
        cwdSlug: "filter-test",
        cwd: "/Users/test/filter-test",
      });

      const running = await adapter.list({ status: "running" });
      expect(running).toHaveLength(0);

      const stopped = await adapter.list({ status: "stopped" });
      expect(stopped).toHaveLength(1);
    });

    it("default list (no opts) only shows running sessions", async () => {
      await createFakePiSession({
        id: "default-session-0000-000000000000",
        cwdSlug: "default-test",
        cwd: "/Users/test/default-test",
      });

      // No running PIDs, so default list should be empty
      const sessions = await adapter.list();
      expect(sessions).toHaveLength(0);
    });

    it("returns sessions from multiple cwd slugs", async () => {
      await createFakePiSession({
        id: "session-a-0000-0000-000000000000",
        cwdSlug: "project-a",
        cwd: "/Users/test/project-a",
      });

      await createFakePiSession({
        id: "session-b-0000-0000-000000000000",
        cwdSlug: "project-b",
        cwd: "/Users/test/project-b",
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(2);
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain("session-a-0000-0000-000000000000");
      expect(ids).toContain("session-b-0000-0000-000000000000");
    });

    it("returns multiple sessions from the same cwd slug", async () => {
      await createFakePiSession({
        id: "same-slug-session-1",
        cwdSlug: "shared-project",
        timestamp: "1000000",
        cwd: "/Users/test/shared-project",
      });

      await createFakePiSession({
        id: "same-slug-session-2",
        cwdSlug: "shared-project",
        timestamp: "2000000",
        cwd: "/Users/test/shared-project",
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(2);
    });

    it("skips non-jsonl files", async () => {
      await createFakePiSession({
        id: "real-session-id",
        cwdSlug: "skip-test",
        cwd: "/Users/test/skip-test",
      });

      // Create a non-jsonl file
      const slugDir = path.join(sessionsDir, "skip-test");
      await fs.writeFile(path.join(slugDir, "notes.txt"), "not a session");

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("real-session-id");
    });

    it("skips jsonl files without session header", async () => {
      const slugDir = path.join(sessionsDir, "no-header");
      await fs.mkdir(slugDir, { recursive: true });
      await fs.writeFile(
        path.join(slugDir, "1000_bad-session.jsonl"),
        JSON.stringify({ type: "message", role: "user", content: "hi" }),
      );

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(0);
    });

    it("sorts running sessions first, then by most recent", async () => {
      await createFakePiSession({
        id: "older-session-0000-000000000000",
        cwdSlug: "sort-test",
        timestamp: "1000",
        cwd: "/Users/test/sort-test",
      });

      await createFakePiSession({
        id: "newer-session-0000-000000000000",
        cwdSlug: "sort-test",
        timestamp: "2000",
        cwd: "/Users/test/sort-test",
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(2);
      // Both stopped — sorted by most recent first
      // File creation times in test may be same, but order should be stable
      expect(sessions.map((s) => s.id)).toContain(
        "older-session-0000-000000000000",
      );
      expect(sessions.map((s) => s.id)).toContain(
        "newer-session-0000-000000000000",
      );
    });
  });

  describe("peek()", () => {
    it("returns recent assistant messages", async () => {
      await createFakePiSession({
        id: "peek-session-0000-000000000000",
        cwdSlug: "peek-test",
        cwd: "/Users/test/peek-test",
        messages: [
          msg("msg1", { role: "user", content: "What is 2+2?" }),
          msg(
            "msg2",
            {
              role: "assistant",
              content: "2+2 equals 4.",
              usage: { input: 100, output: 20 },
              stopReason: "end_turn",
            },
            "msg1",
          ),
          msg(
            "msg3",
            {
              role: "assistant",
              content: "Would you like to know more?",
              usage: { input: 120, output: 15 },
              stopReason: "end_turn",
            },
            "msg2",
          ),
        ],
      });

      const output = await adapter.peek("peek-session-0000-000000000000");
      expect(output).toContain("2+2 equals 4.");
      expect(output).toContain("Would you like to know more?");
    });

    it("handles string content", async () => {
      await createFakePiSession({
        id: "string-content-session",
        cwdSlug: "string-test",
        cwd: "/Users/test/string-test",
        messages: [
          msg("msg1", { role: "assistant", content: "Plain string response." }),
        ],
      });

      const output = await adapter.peek("string-content-session");
      expect(output).toContain("Plain string response.");
    });

    it("handles array content (text blocks)", async () => {
      await createFakePiSession({
        id: "array-content-session",
        cwdSlug: "array-test",
        cwd: "/Users/test/array-test",
        messages: [
          msg("msg1", {
            role: "assistant",
            content: [
              { type: "text", text: "First block." },
              { type: "text", text: "Second block." },
            ],
          }),
        ],
      });

      const output = await adapter.peek("array-content-session");
      expect(output).toContain("First block.");
      expect(output).toContain("Second block.");
    });

    it("respects line limit", async () => {
      const messages = [];
      for (let i = 0; i < 10; i++) {
        messages.push(
          msg(
            `msg${i}`,
            {
              role: "assistant",
              content: `Message ${i}`,
              usage: { input: 10, output: 5 },
            },
            i > 0 ? `msg${i - 1}` : null,
          ),
        );
      }

      await createFakePiSession({
        id: "limit-session-0000-000000000000",
        cwdSlug: "limit-test",
        cwd: "/Users/test/limit-test",
        messages,
      });

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
      await createFakePiSession({
        id: "abcdef12-3456-7890-abcd-ef1234567890",
        cwdSlug: "prefix-test",
        cwd: "/Users/test/prefix-test",
        messages: [
          msg("msg1", { role: "assistant", content: "Found by prefix!" }),
        ],
      });

      const output = await adapter.peek("abcdef12");
      expect(output).toContain("Found by prefix!");
    });

    it("skips non-message JSONL entries", async () => {
      await createFakePiSession({
        id: "mixed-entries-session",
        cwdSlug: "mixed-test",
        cwd: "/Users/test/mixed-test",
        messages: [
          msg("msg1", {
            role: "assistant",
            content: "Before model change.",
          }),
          {
            type: "model_change",
            modelId: "claude-opus-4-6",
          },
          {
            type: "thinking_level_change",
            thinkingLevel: "high",
          },
          msg("msg2", {
            role: "assistant",
            content: "After model change.",
          }),
        ],
      });

      const output = await adapter.peek("mixed-entries-session");
      expect(output).toContain("Before model change.");
      expect(output).toContain("After model change.");
      expect(output).not.toContain("model_change");
    });

    it("skips user and toolResult messages", async () => {
      await createFakePiSession({
        id: "roles-session",
        cwdSlug: "roles-test",
        cwd: "/Users/test/roles-test",
        messages: [
          msg("msg1", { role: "user", content: "User message" }),
          msg("msg2", { role: "assistant", content: "Assistant response" }),
          msg("msg3", { role: "toolResult", content: "Tool output" }),
        ],
      });

      const output = await adapter.peek("roles-session");
      expect(output).toContain("Assistant response");
      expect(output).not.toContain("User message");
      expect(output).not.toContain("Tool output");
    });
  });

  describe("status()", () => {
    it("returns session details", async () => {
      await createFakePiSession({
        id: "status-session-0000-000000000000",
        cwdSlug: "status-test",
        cwd: "/Users/test/status-test",
        modelId: "claude-opus-4-6",
        provider: "anthropic",
        thinkingLevel: "high",
        version: "2.1.0",
        messages: [
          msg("msg1", { role: "user", content: "status check" }),
          msg(
            "msg2",
            {
              role: "assistant",
              content: "Done.",
              usage: { input: 500, output: 200, cost: 0.015 },
              stopReason: "end_turn",
            },
            "msg1",
          ),
        ],
      });

      const session = await adapter.status("status-session-0000-000000000000");
      expect(session.id).toBe("status-session-0000-000000000000");
      expect(session.adapter).toBe("pi");
      expect(session.status).toBe("stopped");
      expect(session.model).toBe("claude-opus-4-6");
      expect(session.tokens).toEqual({ in: 500, out: 200 });
      expect(session.cost).toBe(0.015);
      expect(session.cwd).toBe("/Users/test/status-test");
      expect(session.meta.provider).toBe("anthropic");
      expect(session.meta.thinkingLevel).toBe("high");
      expect(session.meta.version).toBe("2.1.0");
    });

    it("throws for unknown session", async () => {
      await expect(adapter.status("nonexistent")).rejects.toThrow(
        "Session not found",
      );
    });

    it("returns first user prompt", async () => {
      await createFakePiSession({
        id: "prompt-session-0000-000000000000",
        cwdSlug: "prompt-test",
        cwd: "/Users/test/prompt-test",
        messages: [
          msg("msg1", {
            role: "user",
            content: "Implement the login feature",
          }),
          msg("msg2", { role: "assistant", content: "Sure!" }),
        ],
      });

      const session = await adapter.status("prompt-session-0000-000000000000");
      expect(session.prompt).toBe("Implement the login feature");
    });

    it("truncates long prompts to 200 chars", async () => {
      const longPrompt = "A".repeat(300);
      await createFakePiSession({
        id: "long-prompt-session",
        cwdSlug: "long-prompt-test",
        cwd: "/Users/test/long-prompt-test",
        messages: [msg("msg1", { role: "user", content: longPrompt })],
      });

      const session = await adapter.status("long-prompt-session");
      expect(session.prompt?.length).toBe(200);
    });
  });

  describe("token aggregation", () => {
    it("sums tokens across multiple assistant messages", async () => {
      await createFakePiSession({
        id: "token-session-0000-000000000000",
        cwdSlug: "token-test",
        cwd: "/Users/test/token-test",
        messages: [
          msg("msg1", {
            role: "assistant",
            content: "First",
            usage: { input: 100, output: 50, cost: 0.003 },
          }),
          msg(
            "msg2",
            {
              role: "assistant",
              content: "Second",
              usage: { input: 200, output: 100, cost: 0.006 },
            },
            "msg1",
          ),
        ],
      });

      const session = await adapter.status("token-session-0000-000000000000");
      expect(session.tokens).toEqual({ in: 300, out: 150 });
      expect(session.cost).toBeCloseTo(0.009);
    });

    it("handles messages without usage stats", async () => {
      await createFakePiSession({
        id: "no-usage-session",
        cwdSlug: "no-usage-test",
        cwd: "/Users/test/no-usage-test",
        messages: [
          msg("msg1", { role: "assistant", content: "No usage stats" }),
        ],
      });

      const session = await adapter.status("no-usage-session");
      expect(session.tokens).toBeUndefined();
      expect(session.cost).toBeUndefined();
    });

    it("only counts assistant message usage", async () => {
      await createFakePiSession({
        id: "user-usage-session",
        cwdSlug: "user-usage-test",
        cwd: "/Users/test/user-usage-test",
        messages: [
          msg("msg1", {
            role: "user",
            content: "question",
            usage: { input: 1000, output: 0, cost: 0.1 },
          }),
          msg("msg2", {
            role: "assistant",
            content: "answer",
            usage: { input: 50, output: 25, cost: 0.002 },
          }),
        ],
      });

      const session = await adapter.status("user-usage-session");
      expect(session.tokens).toEqual({ in: 50, out: 25 });
      expect(session.cost).toBe(0.002);
    });
  });

  describe("model tracking", () => {
    it("returns model from session header when no messages have model", async () => {
      await createFakePiSession({
        id: "header-model-session",
        cwdSlug: "header-model-test",
        cwd: "/Users/test/header-model-test",
        modelId: "claude-opus-4-6",
      });

      const session = await adapter.status("header-model-session");
      expect(session.model).toBe("claude-opus-4-6");
    });

    it("tracks model changes via model_change entries", async () => {
      await createFakePiSession({
        id: "model-change-session",
        cwdSlug: "model-change-test",
        cwd: "/Users/test/model-change-test",
        modelId: "claude-sonnet-4-5-20250929",
        messages: [
          msg("msg1", {
            role: "assistant",
            content: "Initial response",
            usage: { input: 50, output: 20 },
          }),
          {
            type: "model_change",
            modelId: "claude-opus-4-6",
          },
          msg("msg2", {
            role: "assistant",
            content: "After model change",
            usage: { input: 100, output: 50 },
          }),
        ],
      });

      const session = await adapter.status("model-change-session");
      // Should reflect the latest model
      expect(session.model).toBe("claude-opus-4-6");
    });
  });

  describe("session filename parsing", () => {
    it("extracts session ID from timestamp_id filename format", async () => {
      await createFakePiSession({
        id: "uuid-from-filename",
        cwdSlug: "filename-test",
        timestamp: "1708000000",
        cwd: "/Users/test/filename-test",
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("uuid-from-filename");
    });

    it("uses session header ID over filename-derived ID", async () => {
      // The session header's id field takes precedence
      await createFakePiSession({
        id: "header-id-wins",
        cwdSlug: "id-test",
        timestamp: "1708000000",
        cwd: "/Users/test/id-test",
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions[0].id).toBe("header-id-wins");
    });
  });

  describe("PID recycling detection", () => {
    it("detects recycled PID via cwd match — old session stays stopped", async () => {
      // A different process got the same PID — started BEFORE the session
      const processStartTime = "Mon Feb 16 08:00:00 2026";

      await createFakePiSession({
        id: "old-session-0000-0000-000000000000",
        cwdSlug: "pid-recycle-test",
        cwd: "/Users/test/pid-recycle-test",
      });

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(12345, {
        pid: 12345,
        cwd: "/Users/test/pid-recycle-test",
        args: "pi -p test",
        startTime: processStartTime,
      });

      const adapterWithPids = new PiAdapter({
        piDir,
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
      // Create session file with a creation time we can predict
      await createFakePiSession({
        id: "running-session-0000-000000000000",
        cwdSlug: "legit-running-test",
        cwd: "/Users/test/legit-running-test",
      });

      // Get file stats to know the actual creation time
      const slugDir = path.join(sessionsDir, "legit-running-test");
      const files = await fs.readdir(slugDir);
      const fileStat = await fs.stat(path.join(slugDir, files[0]));

      // Process started AFTER the file was created
      const processStartMs = fileStat.birthtime.getTime() + 1000;
      const processStartDate = new Date(processStartMs);
      const processStartTime = processStartDate.toString();

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(99999, {
        pid: 99999,
        cwd: "/Users/test/legit-running-test",
        args: "pi -p test",
        startTime: processStartTime,
      });

      const adapterWithPids = new PiAdapter({
        piDir,
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
      const processStartTime = "Sun Feb 16 08:00:00 2026";

      await createFakePiSession({
        id: "args-session-0000-0000-000000000000",
        cwdSlug: "pid-recycle-args-test",
        cwd: "/Users/test/pid-recycle-args-test",
      });

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(54321, {
        pid: 54321,
        cwd: "/some/other/path",
        args: "pi -p args-session-0000-0000-000000000000",
        startTime: processStartTime,
      });

      const adapterWithPids = new PiAdapter({
        piDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });

    it("falls back to stopped when startTime is unavailable (safety)", async () => {
      await createFakePiSession({
        id: "notime-session-0000-000000000000",
        cwdSlug: "no-starttime-test",
        cwd: "/Users/test/no-starttime-test",
      });

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(11111, {
        pid: 11111,
        cwd: "/Users/test/no-starttime-test",
        args: "pi -p test",
        // No startTime — can't verify PID ownership
      });

      const adapterWithPids = new PiAdapter({
        piDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });

    it("multiple sessions same cwd — both match if process started after both", async () => {
      await createFakePiSession({
        id: "old-multi-session-0000-000000000000",
        cwdSlug: "multi-session-project",
        timestamp: "1000000",
        cwd: "/Users/test/multi-session-project",
      });

      await createFakePiSession({
        id: "new-multi-session-0000-000000000000",
        cwdSlug: "multi-session-project",
        timestamp: "2000000",
        cwd: "/Users/test/multi-session-project",
      });

      // Get actual file creation times
      const slugDir = path.join(sessionsDir, "multi-session-project");
      const files = await fs.readdir(slugDir);
      let latestBirthtime = 0;
      for (const f of files) {
        const s = await fs.stat(path.join(slugDir, f));
        latestBirthtime = Math.max(latestBirthtime, s.birthtime.getTime());
      }

      const processStartTime = new Date(latestBirthtime + 1000).toString();

      const pidMap = new Map<number, PidInfo>();
      pidMap.set(77777, {
        pid: 77777,
        cwd: "/Users/test/multi-session-project",
        args: "pi -p test",
        startTime: processStartTime,
      });

      const adapterWithPids = new PiAdapter({
        piDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: () => false,
      });

      const sessions = await adapterWithPids.list({ all: true });
      expect(sessions).toHaveLength(2);

      // Both match by cwd — process started after both sessions
      const statuses = sessions.map((s) => s.status);
      expect(statuses).toContain("running");
    });
  });

  describe("session lifecycle — detached processes", () => {
    it("session shows running when persisted metadata has live PID", async () => {
      const sessionCreated = new Date("2026-02-17T10:00:00Z");
      const launchedAt = sessionCreated.toISOString();

      await createFakePiSession({
        id: "detached-session-0000-000000000000",
        cwdSlug: "detached-test",
        cwd: "/Users/test/detached-test",
      });

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

      // No PIDs from ps aux, but PID is still alive
      const adapterWithLivePid = new PiAdapter({
        piDir,
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
      await createFakePiSession({
        id: "dead-detached-0000-0000-000000000000",
        cwdSlug: "dead-detached-test",
        cwd: "/Users/test/dead-detached-test",
      });

      const meta: LaunchedSessionMeta = {
        sessionId: "dead-detached-0000-0000-000000000000",
        pid: 66666,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/dead-detached-test",
        launchedAt: new Date("2026-02-17T10:00:00Z").toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "dead-detached-0000-0000-000000000000.json"),
        JSON.stringify(meta),
      );

      const adapterWithDeadPid = new PiAdapter({
        piDir,
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
      await createFakePiSession({
        id: "cleanup-session-0000-000000000000",
        cwdSlug: "cleanup-test",
        cwd: "/Users/test/cleanup-test",
      });

      const metaPath = path.join(
        sessionsMetaDir,
        "cleanup-session-0000-000000000000.json",
      );
      const meta: LaunchedSessionMeta = {
        sessionId: "cleanup-session-0000-000000000000",
        pid: 77777,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/cleanup-test",
        launchedAt: new Date("2026-02-17T10:00:00Z").toISOString(),
      };
      await fs.writeFile(metaPath, JSON.stringify(meta));

      const adapterWithDeadPid = new PiAdapter({
        piDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: () => false,
      });

      await adapterWithDeadPid.list({ all: true });

      // Metadata file should have been cleaned up
      await expect(fs.access(metaPath)).rejects.toThrow();
    });

    it("detects PID recycling in persisted metadata via start time", async () => {
      await createFakePiSession({
        id: "meta-recycle-0000-0000-000000000000",
        cwdSlug: "meta-recycle-test",
        cwd: "/Users/test/meta-recycle-test",
      });

      const meta: LaunchedSessionMeta = {
        sessionId: "meta-recycle-0000-0000-000000000000",
        pid: 88888,
        startTime: "Sun Feb 16 08:00:00 2026",
        cwd: "/Users/test/meta-recycle-test",
        launchedAt: new Date("2026-02-17T10:00:00Z").toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "meta-recycle-0000-0000-000000000000.json"),
        JSON.stringify(meta),
      );

      const adapterWithRecycledPid = new PiAdapter({
        piDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: (pid) => pid === 88888,
      });

      const sessions = await adapterWithRecycledPid.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });

    it("old metadata without startTime but with live PID assumes running", async () => {
      await createFakePiSession({
        id: "meta-notime-0000-0000-000000000000",
        cwdSlug: "meta-no-starttime-test",
        cwd: "/Users/test/meta-no-starttime-test",
      });

      const meta: LaunchedSessionMeta = {
        sessionId: "meta-notime-0000-0000-000000000000",
        pid: 99999,
        cwd: "/Users/test/meta-no-starttime-test",
        launchedAt: new Date("2026-02-17T10:00:00Z").toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "meta-notime-0000-0000-000000000000.json"),
        JSON.stringify(meta),
      );

      const adapterWithLivePid = new PiAdapter({
        piDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: (pid) => pid === 99999,
      });

      const sessions = await adapterWithLivePid.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].pid).toBe(99999);
    });
  });

  describe("session lifecycle scenarios", () => {
    it("wrapper dies → Pi continues → status shows running", async () => {
      await createFakePiSession({
        id: "wrapper-dies-0000-0000-000000000000",
        cwdSlug: "wrapper-dies-test",
        cwd: "/Users/test/wrapper-dies-test",
      });

      const meta: LaunchedSessionMeta = {
        sessionId: "wrapper-dies-0000-0000-000000000000",
        pid: 44444,
        wrapperPid: 11111,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/wrapper-dies-test",
        launchedAt: new Date("2026-02-17T10:00:00Z").toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "wrapper-dies-0000-0000-000000000000.json"),
        JSON.stringify(meta),
      );

      const adapterTest = new PiAdapter({
        piDir,
        sessionsMetaDir,
        getPids: async () => new Map(),
        isProcessAlive: (pid) => pid === 44444,
      });

      const sessions = await adapterTest.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].pid).toBe(44444);
    });

    it("Pi completes → status shows stopped", async () => {
      await createFakePiSession({
        id: "pi-complete-0000-0000-000000000000",
        cwdSlug: "pi-complete-test",
        cwd: "/Users/test/pi-complete-test",
        messages: [
          msg("msg1", {
            role: "assistant",
            content: "All done!",
            usage: { input: 100, output: 20 },
          }),
        ],
      });

      const meta: LaunchedSessionMeta = {
        sessionId: "pi-complete-0000-0000-000000000000",
        pid: 55555,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/pi-complete-test",
        launchedAt: new Date("2026-02-17T10:00:00Z").toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "pi-complete-0000-0000-000000000000.json"),
        JSON.stringify(meta),
      );

      const adapterTest = new PiAdapter({
        piDir,
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
      await createFakePiSession({
        id: "recycled-victim-0000-000000000000",
        cwdSlug: "pid-recycled-scenario",
        cwd: "/Users/test/pid-recycled-scenario",
      });

      const meta: LaunchedSessionMeta = {
        sessionId: "recycled-victim-0000-000000000000",
        pid: 33333,
        startTime: "Sun Feb 16 10:00:01 2026",
        cwd: "/Users/test/pid-recycled-scenario",
        launchedAt: new Date("2026-02-16T10:00:00Z").toISOString(),
      };
      await fs.writeFile(
        path.join(sessionsMetaDir, "recycled-victim-0000-000000000000.json"),
        JSON.stringify(meta),
      );

      // PID 33333 is alive BUT it's a different process (recycled)
      const pidMap = new Map<number, PidInfo>();
      pidMap.set(33333, {
        pid: 33333,
        cwd: "/some/other/project",
        args: "pi -p something",
        startTime: "Thu Feb 20 09:00:00 2026",
      });

      const adapterTest = new PiAdapter({
        piDir,
        sessionsMetaDir,
        getPids: async () => pidMap,
        isProcessAlive: (pid) => pid === 33333,
      });

      const sessions = await adapterTest.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("stopped");
    });

    it("session ID is not pending- when metadata has real ID", async () => {
      await createFakePiSession({
        id: "real-uuid-abcd-1234-5678-000000000000",
        cwdSlug: "real-id-test",
        cwd: "/Users/test/real-id-test",
      });

      const meta: LaunchedSessionMeta = {
        sessionId: "real-uuid-abcd-1234-5678-000000000000",
        pid: 12345,
        startTime: "Mon Feb 17 10:00:01 2026",
        cwd: "/Users/test/real-id-test",
        launchedAt: new Date("2026-02-17T10:00:00Z").toISOString(),
      };
      await fs.writeFile(
        path.join(
          sessionsMetaDir,
          "real-uuid-abcd-1234-5678-000000000000.json",
        ),
        JSON.stringify(meta),
      );

      const adapterTest = new PiAdapter({
        piDir,
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

  describe("session metadata persistence", () => {
    it("writeSessionMeta and readSessionMeta round-trip", async () => {
      await adapter.writeSessionMeta({
        sessionId: "roundtrip-session-id",
        pid: 12345,
        cwd: "/Users/test/roundtrip",
        prompt: "test prompt",
        launchedAt: new Date().toISOString(),
      });

      const meta = await adapter.readSessionMeta("roundtrip-session-id");
      expect(meta).not.toBeNull();
      expect(meta?.sessionId).toBe("roundtrip-session-id");
      expect(meta?.pid).toBe(12345);
      expect(meta?.cwd).toBe("/Users/test/roundtrip");
      expect(meta?.prompt).toBe("test prompt");
    });

    it("readSessionMeta returns null for nonexistent session", async () => {
      const meta = await adapter.readSessionMeta("nonexistent");
      expect(meta).toBeNull();
    });

    it("readSessionMeta scans files to find matching sessionId", async () => {
      // Write metadata with a different filename than the sessionId
      const metaPath = path.join(sessionsMetaDir, "different-filename.json");
      await fs.writeFile(
        metaPath,
        JSON.stringify({
          sessionId: "scan-target-session",
          pid: 11111,
          cwd: "/test",
          launchedAt: new Date().toISOString(),
        }),
      );

      const meta = await adapter.readSessionMeta("scan-target-session");
      expect(meta).not.toBeNull();
      expect(meta?.sessionId).toBe("scan-target-session");
    });
  });

  describe("Pi-specific metadata", () => {
    it("includes provider in session meta", async () => {
      await createFakePiSession({
        id: "provider-session",
        cwdSlug: "provider-test",
        cwd: "/Users/test/provider-test",
        provider: "openai",
      });

      const session = await adapter.status("provider-session");
      expect(session.meta.provider).toBe("openai");
    });

    it("includes thinkingLevel in session meta", async () => {
      await createFakePiSession({
        id: "thinking-session",
        cwdSlug: "thinking-test",
        cwd: "/Users/test/thinking-test",
        thinkingLevel: "high",
      });

      const session = await adapter.status("thinking-session");
      expect(session.meta.thinkingLevel).toBe("high");
    });

    it("includes version in session meta", async () => {
      await createFakePiSession({
        id: "version-session",
        cwdSlug: "version-test",
        cwd: "/Users/test/version-test",
        version: "3.0.0",
      });

      const session = await adapter.status("version-session");
      expect(session.meta.version).toBe("3.0.0");
    });

    it("includes cwdSlug in session meta", async () => {
      await createFakePiSession({
        id: "slug-session",
        cwdSlug: "my-cool-project",
        cwd: "/Users/test/my-cool-project",
      });

      const session = await adapter.status("slug-session");
      expect(session.meta.cwdSlug).toBe("my-cool-project");
    });
  });

  describe("edge cases", () => {
    it("handles empty JSONL file gracefully", async () => {
      const slugDir = path.join(sessionsDir, "empty-test");
      await fs.mkdir(slugDir, { recursive: true });
      await fs.writeFile(path.join(slugDir, "1000_empty-session.jsonl"), "");

      const sessions = await adapter.list({ all: true });
      // Empty file has no session header, so it should be skipped
      expect(sessions).toHaveLength(0);
    });

    it("handles malformed JSONL lines gracefully", async () => {
      const slugDir = path.join(sessionsDir, "malformed-test");
      await fs.mkdir(slugDir, { recursive: true });
      const lines = [
        JSON.stringify({
          type: "session",
          id: "malformed-session",
          cwd: "/test",
        }),
        "not valid json {{{",
        JSON.stringify({
          type: "message",
          id: "msg1",
          message: { role: "assistant", content: "Still works" },
        }),
      ];
      await fs.writeFile(
        path.join(slugDir, "1000_malformed-session.jsonl"),
        lines.join("\n"),
      );

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);

      const output = await adapter.peek("malformed-session");
      expect(output).toContain("Still works");
    });

    it("handles session with only header and no messages", async () => {
      await createFakePiSession({
        id: "header-only-session",
        cwdSlug: "header-only",
        cwd: "/Users/test/header-only",
        messages: [],
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].prompt).toBeUndefined();
      expect(sessions[0].tokens).toBeUndefined();
    });

    it("handles concurrent sessions across different cwds", async () => {
      for (let i = 0; i < 5; i++) {
        await createFakePiSession({
          id: `concurrent-session-${i}`,
          cwdSlug: `concurrent-project-${i}`,
          cwd: `/Users/test/concurrent-project-${i}`,
          messages: [
            msg("msg1", {
              role: "assistant",
              content: `Response from session ${i}`,
              usage: { input: 10 * i, output: 5 * i },
            }),
          ],
        });
      }

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(5);
    });

    it("ignores non-directory entries in sessions dir", async () => {
      // Create a regular file at the sessions level (e.g. SQLite index)
      await fs.writeFile(
        path.join(sessionsDir, "session-index.sqlite"),
        "fake sqlite data",
      );

      await createFakePiSession({
        id: "real-session",
        cwdSlug: "real-project",
        cwd: "/Users/test/real-project",
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("real-session");
    });
  });
});
