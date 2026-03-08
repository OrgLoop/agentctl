import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "./state.js";
import {
  buildWebhookPayload,
  computeSignature,
  emitWebhook,
  resolveWebhookConfig,
} from "./webhook.js";

describe("resolveWebhookConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when no url configured", () => {
    delete process.env.AGENTCTL_WEBHOOK_URL;
    expect(resolveWebhookConfig()).toBeNull();
    expect(resolveWebhookConfig({})).toBeNull();
  });

  it("reads from config object", () => {
    delete process.env.AGENTCTL_WEBHOOK_URL;
    delete process.env.AGENTCTL_WEBHOOK_SECRET;
    const cfg = resolveWebhookConfig({
      webhook_url: "https://example.com/hook",
      webhook_secret: "s3cret",
    });
    expect(cfg).toEqual({
      url: "https://example.com/hook",
      secret: "s3cret",
    });
  });

  it("env vars override config", () => {
    process.env.AGENTCTL_WEBHOOK_URL = "https://env.example.com";
    process.env.AGENTCTL_WEBHOOK_SECRET = "env-secret";
    const cfg = resolveWebhookConfig({
      webhook_url: "https://config.example.com",
      webhook_secret: "config-secret",
    });
    expect(cfg).toEqual({
      url: "https://env.example.com",
      secret: "env-secret",
    });
  });

  it("works with url only (no secret)", () => {
    delete process.env.AGENTCTL_WEBHOOK_URL;
    delete process.env.AGENTCTL_WEBHOOK_SECRET;
    const cfg = resolveWebhookConfig({ webhook_url: "https://example.com" });
    expect(cfg).toEqual({ url: "https://example.com", secret: undefined });
  });
});

describe("buildWebhookPayload", () => {
  it("builds correct payload from session record", () => {
    const record: SessionRecord = {
      id: "sess-123",
      adapter: "claude-code",
      status: "stopped",
      startedAt: "2026-03-07T10:00:00.000Z",
      stoppedAt: "2026-03-07T10:05:00.000Z",
      cwd: "/home/user/project",
      prompt: "Fix the bug",
      meta: { openclaw_callback_session_key: "key-1" },
    };

    const payload = buildWebhookPayload(record);
    expect(payload.hook_type).toBe("session.stopped");
    expect(payload.session_id).toBe("sess-123");
    expect(payload.adapter).toBe("claude-code");
    expect(payload.cwd).toBe("/home/user/project");
    expect(payload.duration_seconds).toBe(300);
    expect(payload.exit_status).toBe("stopped");
    expect(payload.summary).toBe("Fix the bug");
    expect(payload.meta).toEqual({
      openclaw_callback_session_key: "key-1",
    });
    expect(payload.timestamp).toBeTruthy();
  });
});

describe("computeSignature", () => {
  it("returns consistent HMAC-SHA256 hex", () => {
    const sig1 = computeSignature('{"test":1}', "secret");
    const sig2 = computeSignature('{"test":1}', "secret");
    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(64); // SHA256 hex = 64 chars
  });

  it("different secrets produce different signatures", () => {
    const sig1 = computeSignature("data", "secret1");
    const sig2 = computeSignature("data", "secret2");
    expect(sig1).not.toBe(sig2);
  });
});

describe("emitWebhook", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends POST with JSON body", async () => {
    const payload = buildWebhookPayload({
      id: "s1",
      adapter: "claude-code",
      status: "stopped",
      startedAt: "2026-03-07T10:00:00Z",
      stoppedAt: "2026-03-07T10:01:00Z",
      meta: {},
    });

    await emitWebhook({ url: "https://example.com/hook" }, payload);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://example.com/hook");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(opts.headers["X-Agentctl-Signature"]).toBeUndefined();
  });

  it("includes HMAC signature when secret is provided", async () => {
    const payload = buildWebhookPayload({
      id: "s1",
      adapter: "claude-code",
      status: "stopped",
      startedAt: "2026-03-07T10:00:00Z",
      meta: {},
    });

    await emitWebhook(
      { url: "https://example.com/hook", secret: "my-secret" },
      payload,
    );

    const [, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.headers["X-Agentctl-Signature"]).toBeTruthy();
    expect(opts.headers["X-Agentctl-Signature"]).toHaveLength(64);
  });

  it("does not throw on fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    // Should not throw
    await emitWebhook(
      { url: "https://example.com/hook" },
      buildWebhookPayload({
        id: "s1",
        adapter: "claude-code",
        status: "stopped",
        startedAt: "2026-03-07T10:00:00Z",
        meta: {},
      }),
    );
  });
});
