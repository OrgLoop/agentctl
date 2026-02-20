import { describe, expect, it, vi } from "vitest";
import {
  OpenClawAdapter,
  type RpcCallFn,
  type SessionsListResult,
  type SessionsPreviewResult,
} from "./openclaw.js";

const now = Date.now();
const fiveMinAgo = now - 5 * 60 * 1000 + 30_000; // just under 5 min ago — "running"
const hourAgo = now - 60 * 60 * 1000; // 1 hour ago — "idle"

function makeListResult(
  sessions: SessionsListResult["sessions"] = [],
): SessionsListResult {
  return {
    ts: now,
    path: "/mock/store.json",
    count: sessions.length,
    defaults: {
      modelProvider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      contextTokens: 200_000,
    },
    sessions,
  };
}

function makePreviewResult(
  previews: SessionsPreviewResult["previews"] = [],
): SessionsPreviewResult {
  return { ts: now, previews };
}

function makeMockRpc(
  handlers: Record<string, (params: Record<string, unknown>) => unknown>,
): RpcCallFn {
  return async (method, params) => {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unexpected RPC method: ${method}`);
    return handler(params);
  };
}

// --- Tests ---

describe("OpenClawAdapter", () => {
  it("has correct id", () => {
    const adapter = new OpenClawAdapter({ rpcCall: makeMockRpc({}) });
    expect(adapter.id).toBe("openclaw");
  });

  describe("list()", () => {
    it("returns empty array with warning when token is missing", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const adapter = new OpenClawAdapter({
        authToken: "",
        rpcCall: makeMockRpc({}),
      });
      const sessions = await adapter.list();
      expect(sessions).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("OPENCLAW_WEBHOOK_TOKEN is not set"),
      );
      warnSpy.mockRestore();
    });

    it("returns empty array with warning when gateway is unreachable", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const adapter = new OpenClawAdapter({
        authToken: "test-token",
        rpcCall: async () => {
          throw new Error("connection refused");
        },
      });
      const sessions = await adapter.list();
      expect(sessions).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("OpenClaw gateway unreachable"),
      );
      warnSpy.mockRestore();
    });

    it("warns about auth failure specifically", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const adapter = new OpenClawAdapter({
        authToken: "bad-token",
        rpcCall: async () => {
          throw new Error("OpenClaw gateway auth failed");
        },
      });
      const sessions = await adapter.list();
      expect(sessions).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("authentication failed"),
      );
      warnSpy.mockRestore();
    });

    it("returns mapped sessions from gateway", async () => {
      const adapter = new OpenClawAdapter({
        authToken: "test-token",
        rpcCall: makeMockRpc({
          "sessions.list": () =>
            makeListResult([
              {
                key: "agent:jarvis:main",
                kind: "direct",
                label: "main",
                displayName: "Main Session",
                derivedTitle: "Help me with code",
                updatedAt: fiveMinAgo,
                sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                inputTokens: 1000,
                outputTokens: 500,
                model: "claude-opus-4-6",
                modelProvider: "anthropic",
              },
            ]),
        }),
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect(sessions[0].adapter).toBe("openclaw");
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].model).toBe("claude-opus-4-6");
      expect(sessions[0].tokens).toEqual({ in: 1000, out: 500 });
      expect(sessions[0].prompt).toBe("Help me with code");
      expect(sessions[0].meta.key).toBe("agent:jarvis:main");
    });

    it("classifies old sessions as idle", async () => {
      const adapter = new OpenClawAdapter({
        authToken: "test-token",
        rpcCall: makeMockRpc({
          "sessions.list": () =>
            makeListResult([
              {
                key: "agent:jarvis:old-session",
                kind: "direct",
                updatedAt: hourAgo,
                sessionId: "old-session-id",
              },
            ]),
        }),
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].status).toBe("idle");
    });

    it("default list shows running and idle sessions", async () => {
      const adapter = new OpenClawAdapter({
        authToken: "test-token",
        rpcCall: makeMockRpc({
          "sessions.list": () =>
            makeListResult([
              {
                key: "agent:jarvis:active",
                kind: "direct",
                updatedAt: fiveMinAgo,
                sessionId: "active-id",
              },
              {
                key: "agent:jarvis:old",
                kind: "direct",
                updatedAt: hourAgo,
                sessionId: "old-id",
              },
            ]),
        }),
      });

      // OpenClaw sessions are either "running" (recently active) or "idle"
      // (quiescent). Default list includes both.
      const sessions = await adapter.list();
      expect(sessions).toHaveLength(2);
      expect(sessions[0].status).toBe("running");
      expect(sessions[1].status).toBe("idle");
    });

    it("filters by status", async () => {
      const adapter = new OpenClawAdapter({
        authToken: "test-token",
        rpcCall: makeMockRpc({
          "sessions.list": () =>
            makeListResult([
              {
                key: "agent:jarvis:active",
                kind: "direct",
                updatedAt: fiveMinAgo,
                sessionId: "active-id",
              },
              {
                key: "agent:jarvis:idle",
                kind: "direct",
                updatedAt: hourAgo,
                sessionId: "idle-id",
              },
            ]),
        }),
      });

      const idle = await adapter.list({ status: "idle" });
      expect(idle).toHaveLength(1);
      expect(idle[0].id).toBe("idle-id");

      const running = await adapter.list({ status: "running" });
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe("active-id");
    });

    it("uses session key as id when sessionId is missing", async () => {
      const adapter = new OpenClawAdapter({
        authToken: "test-token",
        rpcCall: makeMockRpc({
          "sessions.list": () =>
            makeListResult([
              {
                key: "agent:jarvis:no-session-id",
                kind: "direct",
                updatedAt: fiveMinAgo,
              },
            ]),
        }),
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions[0].id).toBe("agent:jarvis:no-session-id");
    });

    it("uses default model when row has no model", async () => {
      const adapter = new OpenClawAdapter({
        authToken: "test-token",
        rpcCall: makeMockRpc({
          "sessions.list": () =>
            makeListResult([
              {
                key: "agent:jarvis:test",
                kind: "direct",
                updatedAt: fiveMinAgo,
                sessionId: "test-id",
              },
            ]),
        }),
      });

      const sessions = await adapter.list({ all: true });
      expect(sessions[0].model).toBe("claude-sonnet-4-5-20250929");
    });
  });

  describe("peek()", () => {
    it("returns assistant messages from preview", async () => {
      const adapter = new OpenClawAdapter({
        authToken: "test-token",
        rpcCall: makeMockRpc({
          "sessions.list": () =>
            makeListResult([
              {
                key: "agent:jarvis:peek-test",
                kind: "direct",
                updatedAt: fiveMinAgo,
                sessionId: "peek-session-id",
              },
            ]),
          "sessions.preview": () =>
            makePreviewResult([
              {
                key: "agent:jarvis:peek-test",
                status: "ok" as const,
                items: [
                  { role: "user", text: "Hello" },
                  { role: "assistant", text: "Hi there!" },
                  { role: "user", text: "How are you?" },
                  { role: "assistant", text: "I'm doing well." },
                ],
              },
            ]),
        }),
      });

      const output = await adapter.peek("peek-session-id");
      expect(output).toContain("Hi there!");
      expect(output).toContain("I'm doing well.");
      expect(output).not.toContain("Hello");
    });

    it("respects line limit", async () => {
      const items: Array<{ role: string; text: string }> = [];
      for (let i = 0; i < 10; i++) {
        items.push({ role: "assistant", text: `Message ${i}` });
      }

      const adapter = new OpenClawAdapter({
        authToken: "test-token",
        rpcCall: makeMockRpc({
          "sessions.list": () =>
            makeListResult([
              {
                key: "agent:jarvis:limit-test",
                kind: "direct",
                updatedAt: fiveMinAgo,
                sessionId: "limit-session-id",
              },
            ]),
          "sessions.preview": () =>
            makePreviewResult([
              {
                key: "agent:jarvis:limit-test",
                status: "ok" as const,
                items,
              },
            ]),
        }),
      });

      const output = await adapter.peek("limit-session-id", { lines: 3 });
      expect(output).toContain("Message 7");
      expect(output).toContain("Message 8");
      expect(output).toContain("Message 9");
      expect(output).not.toContain("Message 6");
    });

    it("throws for unknown session", async () => {
      const adapter = new OpenClawAdapter({
        authToken: "test-token",
        rpcCall: makeMockRpc({
          "sessions.list": () => makeListResult([]),
        }),
      });

      await expect(adapter.peek("nonexistent")).rejects.toThrow(
        "Session not found",
      );
    });

    it("supports prefix matching", async () => {
      const adapter = new OpenClawAdapter({
        authToken: "test-token",
        rpcCall: makeMockRpc({
          "sessions.list": () =>
            makeListResult([
              {
                key: "agent:jarvis:prefix-test",
                kind: "direct",
                updatedAt: fiveMinAgo,
                sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
              },
            ]),
          "sessions.preview": () =>
            makePreviewResult([
              {
                key: "agent:jarvis:prefix-test",
                status: "ok" as const,
                items: [{ role: "assistant", text: "Found by prefix!" }],
              },
            ]),
        }),
      });

      const output = await adapter.peek("abcdef12");
      expect(output).toContain("Found by prefix!");
    });
  });

  describe("status()", () => {
    it("throws when token is missing", async () => {
      const adapter = new OpenClawAdapter({
        authToken: "",
        rpcCall: makeMockRpc({}),
      });
      await expect(adapter.status("some-id")).rejects.toThrow(
        "OPENCLAW_WEBHOOK_TOKEN is not set",
      );
    });

    it("returns session details", async () => {
      const adapter = new OpenClawAdapter({
        authToken: "test-token",
        rpcCall: makeMockRpc({
          "sessions.list": () =>
            makeListResult([
              {
                key: "agent:jarvis:status-test",
                kind: "direct",
                displayName: "Status Test",
                updatedAt: fiveMinAgo,
                sessionId: "status-session-id",
                inputTokens: 500,
                outputTokens: 200,
                model: "claude-opus-4-6",
                modelProvider: "anthropic",
              },
            ]),
        }),
      });

      const session = await adapter.status("status-session-id");
      expect(session.id).toBe("status-session-id");
      expect(session.adapter).toBe("openclaw");
      expect(session.status).toBe("running");
      expect(session.model).toBe("claude-opus-4-6");
      expect(session.tokens).toEqual({ in: 500, out: 200 });
    });

    it("throws for unknown session", async () => {
      const adapter = new OpenClawAdapter({
        authToken: "test-token",
        rpcCall: makeMockRpc({
          "sessions.list": () => makeListResult([]),
        }),
      });

      await expect(adapter.status("nonexistent")).rejects.toThrow(
        "Session not found",
      );
    });

    it("supports prefix matching", async () => {
      const adapter = new OpenClawAdapter({
        authToken: "test-token",
        rpcCall: makeMockRpc({
          "sessions.list": () =>
            makeListResult([
              {
                key: "agent:jarvis:prefix-status",
                kind: "direct",
                updatedAt: fiveMinAgo,
                sessionId: "abcdef12-9999-9999-9999-999999999999",
                model: "claude-opus-4-6",
              },
            ]),
        }),
      });

      const session = await adapter.status("abcdef12");
      expect(session.id).toBe("abcdef12-9999-9999-9999-999999999999");
    });
  });

  describe("unsupported operations", () => {
    it("launch throws", async () => {
      const adapter = new OpenClawAdapter({ rpcCall: makeMockRpc({}) });
      await expect(
        adapter.launch({ adapter: "openclaw", prompt: "test" }),
      ).rejects.toThrow("cannot be launched");
    });

    it("stop throws", async () => {
      const adapter = new OpenClawAdapter({ rpcCall: makeMockRpc({}) });
      await expect(adapter.stop("some-id")).rejects.toThrow(
        "cannot be stopped",
      );
    });

    it("resume throws", async () => {
      const adapter = new OpenClawAdapter({ rpcCall: makeMockRpc({}) });
      await expect(adapter.resume("some-id", "msg")).rejects.toThrow(
        "Cannot resume",
      );
    });
  });
});
