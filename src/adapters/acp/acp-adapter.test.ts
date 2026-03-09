import type { StopReason } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpAdapter } from "./acp-adapter.js";
import type { AcpAgentConfig, AcpClient, AcpSession } from "./acp-client.js";

// --- Mock AcpClient ---

function createMockSession(overrides?: Partial<AcpSession>): AcpSession {
  return {
    sessionId: "test-session-1",
    agentConfig: { command: "test-agent", name: "Test Agent" },
    cwd: "/test/project",
    pid: 12345,
    status: "idle",
    output: { messages: [], toolCalls: [] },
    startedAt: new Date("2026-03-01T10:00:00Z"),
    ...overrides,
  };
}

function createMockClient(session?: AcpSession): AcpClient {
  const mockSession = session ?? createMockSession();
  const sessions = new Map<string, AcpSession>([
    [mockSession.sessionId, mockSession],
  ]);

  return {
    connect: vi.fn().mockResolvedValue(mockSession),
    prompt: vi.fn().mockResolvedValue("end_turn" as StopReason),
    promptDetached: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn((id: string) => sessions.get(id)),
    getAllSessions: vi.fn(() => [...sessions.values()]),
    isAlive: vi.fn(() => true),
    disconnect: vi.fn(() => {
      for (const s of sessions.values()) {
        s.status = "disconnected";
        s.stoppedAt = new Date();
      }
    }),
    forceKill: vi.fn(() => {
      for (const s of sessions.values()) {
        s.status = "disconnected";
        s.stoppedAt = new Date();
      }
    }),
    getOutput: vi.fn((id: string) => sessions.get(id)?.output),
  } as unknown as AcpClient;
}

const testConfig: AcpAgentConfig = {
  command: "test-agent",
  name: "Test Agent",
};

let adapter: AcpAdapter;
let mockClient: AcpClient;

beforeEach(() => {
  mockClient = createMockClient();
  adapter = new AcpAdapter("test-acp", {
    agentConfig: testConfig,
    createClient: () => mockClient,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AcpAdapter", () => {
  describe("launch", () => {
    it("launches a session via ACP client", async () => {
      const session = await adapter.launch({
        adapter: "test-acp",
        prompt: "Fix the bug",
        cwd: "/test/project",
      });

      expect(session.id).toBe("test-session-1");
      expect(session.adapter).toBe("test-acp");
      expect(session.status).toBe("running");
      expect(session.cwd).toBe("/test/project");
      expect(session.prompt).toBe("Fix the bug");
      expect(session.pid).toBe(12345);
      expect(session.meta.transport).toBe("acp");
    });

    it("connects the ACP client with correct options", async () => {
      await adapter.launch({
        adapter: "test-acp",
        prompt: "Fix the bug",
        cwd: "/my/dir",
        env: { FOO: "bar" },
      });

      expect(mockClient.connect).toHaveBeenCalledWith({
        cwd: "/my/dir",
        env: { FOO: "bar" },
        permissionPolicy: "auto-approve",
      });
    });

    it("fires prompt detached after launch", async () => {
      await adapter.launch({
        adapter: "test-acp",
        prompt: "Do the thing",
        cwd: "/test",
      });

      expect(mockClient.promptDetached).toHaveBeenCalledWith(
        "test-session-1",
        "Do the thing",
      );
    });

    it("truncates prompt in session to 200 chars", async () => {
      const longPrompt = "x".repeat(300);
      const session = await adapter.launch({
        adapter: "test-acp",
        prompt: longPrompt,
        cwd: "/test",
      });

      expect(session.prompt).toHaveLength(200);
    });
  });

  describe("discover", () => {
    it("returns empty when no sessions launched", async () => {
      const freshAdapter = new AcpAdapter("test-acp", {
        agentConfig: testConfig,
        createClient: () => createMockClient(),
      });
      const discovered = await freshAdapter.discover();
      expect(discovered).toEqual([]);
    });

    it("returns launched sessions", async () => {
      await adapter.launch({
        adapter: "test-acp",
        prompt: "Test",
        cwd: "/test",
      });

      const discovered = await adapter.discover();
      expect(discovered).toHaveLength(1);
      expect(discovered[0].id).toBe("test-session-1");
      expect(discovered[0].status).toBe("running");
      expect(discovered[0].adapter).toBe("test-acp");
    });

    it("reports disconnected sessions as stopped", async () => {
      const session = createMockSession({ status: "disconnected" });
      const client = createMockClient(session);
      const adapterWithStopped = new AcpAdapter("test-acp", {
        agentConfig: testConfig,
        createClient: () => client,
      });

      await adapterWithStopped.launch({
        adapter: "test-acp",
        prompt: "Test",
        cwd: "/test",
      });

      // Manually mark as disconnected
      session.status = "disconnected";
      session.stoppedAt = new Date();

      const discovered = await adapterWithStopped.discover();
      expect(discovered[0].status).toBe("stopped");
    });
  });

  describe("isAlive", () => {
    it("returns false for unknown session", async () => {
      expect(await adapter.isAlive("nonexistent")).toBe(false);
    });

    it("returns true for active session", async () => {
      await adapter.launch({
        adapter: "test-acp",
        prompt: "Test",
        cwd: "/test",
      });

      expect(await adapter.isAlive("test-session-1")).toBe(true);
    });
  });

  describe("list", () => {
    it("returns running sessions by default", async () => {
      await adapter.launch({
        adapter: "test-acp",
        prompt: "Test",
        cwd: "/test",
      });

      const sessions = await adapter.list();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("running");
    });

    it("filters by status", async () => {
      await adapter.launch({
        adapter: "test-acp",
        prompt: "Test",
        cwd: "/test",
      });

      const stopped = await adapter.list({ status: "stopped" });
      expect(stopped).toHaveLength(0);

      const running = await adapter.list({ status: "running" });
      expect(running).toHaveLength(1);
    });
  });

  describe("peek", () => {
    it("throws for unknown session", async () => {
      await expect(adapter.peek("nonexistent")).rejects.toThrow(
        "Session not found",
      );
    });

    it("returns collected messages", async () => {
      const session = createMockSession({
        output: {
          messages: ["Hello world", "I fixed the bug"],
          toolCalls: [],
        },
      });
      const client = createMockClient(session);
      const a = new AcpAdapter("test-acp", {
        agentConfig: testConfig,
        createClient: () => client,
      });

      await a.launch({
        adapter: "test-acp",
        prompt: "Test",
        cwd: "/test",
      });

      const output = await a.peek("test-session-1");
      expect(output).toContain("Hello world");
      expect(output).toContain("I fixed the bug");
    });

    it("respects lines limit", async () => {
      const messages = Array.from({ length: 10 }, (_, i) => `Message ${i}`);
      const session = createMockSession({
        output: { messages, toolCalls: [] },
      });
      const client = createMockClient(session);
      const a = new AcpAdapter("test-acp", {
        agentConfig: testConfig,
        createClient: () => client,
      });

      await a.launch({
        adapter: "test-acp",
        prompt: "Test",
        cwd: "/test",
      });

      const output = await a.peek("test-session-1", { lines: 3 });
      expect(output).not.toContain("Message 0");
      expect(output).toContain("Message 9");
    });
  });

  describe("status", () => {
    it("throws for unknown session", async () => {
      await expect(adapter.status("nonexistent")).rejects.toThrow(
        "Session not found",
      );
    });

    it("returns session details", async () => {
      await adapter.launch({
        adapter: "test-acp",
        prompt: "Test",
        cwd: "/test",
      });

      const s = await adapter.status("test-session-1");
      expect(s.id).toBe("test-session-1");
      expect(s.adapter).toBe("test-acp");
      expect(s.status).toBe("running");
    });
  });

  describe("stop", () => {
    it("throws for unknown session", async () => {
      await expect(adapter.stop("nonexistent")).rejects.toThrow(
        "No active session",
      );
    });

    it("cancels and disconnects the client", async () => {
      await adapter.launch({
        adapter: "test-acp",
        prompt: "Test",
        cwd: "/test",
      });

      await adapter.stop("test-session-1");
      expect(mockClient.cancel).toHaveBeenCalledWith("test-session-1");
      expect(mockClient.disconnect).toHaveBeenCalled();
    });

    it("force kills when force option is set", async () => {
      await adapter.launch({
        adapter: "test-acp",
        prompt: "Test",
        cwd: "/test",
      });

      await adapter.stop("test-session-1", { force: true });
      expect(mockClient.forceKill).toHaveBeenCalled();
    });
  });

  describe("resume", () => {
    it("sends prompt detached to existing session", async () => {
      await adapter.launch({
        adapter: "test-acp",
        prompt: "Test",
        cwd: "/test",
      });

      await adapter.resume("test-session-1", "Follow-up question");
      expect(mockClient.promptDetached).toHaveBeenCalledWith(
        "test-session-1",
        "Follow-up question",
      );
    });

    it("throws for unknown session", async () => {
      await expect(adapter.resume("nonexistent", "msg")).rejects.toThrow(
        "No active session",
      );
    });
  });
});
