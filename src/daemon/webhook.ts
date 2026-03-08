import crypto from "node:crypto";
import type { SessionRecord } from "./state.js";

export interface WebhookConfig {
  url: string;
  secret?: string;
}

export interface WebhookPayload {
  hook_type: "session.stopped";
  session_id: string;
  cwd?: string;
  adapter: string;
  duration_seconds: number;
  exit_status: string;
  summary?: string;
  meta: Record<string, unknown>;
  timestamp: string;
}

/**
 * Resolve webhook config from environment variables and/or config object.
 * Env vars take precedence over config file values.
 */
export function resolveWebhookConfig(config?: {
  webhook_url?: string;
  webhook_secret?: string;
}): WebhookConfig | null {
  const url = process.env.AGENTCTL_WEBHOOK_URL || config?.webhook_url;
  if (!url) return null;

  const secret = process.env.AGENTCTL_WEBHOOK_SECRET || config?.webhook_secret;

  return { url, secret };
}

/**
 * Build a webhook payload from a stopped session record.
 */
export function buildWebhookPayload(session: SessionRecord): WebhookPayload {
  const startedAt = new Date(session.startedAt).getTime();
  const stoppedAt = session.stoppedAt
    ? new Date(session.stoppedAt).getTime()
    : Date.now();
  const durationSeconds = Math.max(
    0,
    Math.round((stoppedAt - startedAt) / 1000),
  );

  return {
    hook_type: "session.stopped",
    session_id: session.id,
    cwd: session.cwd,
    adapter: session.adapter,
    duration_seconds: durationSeconds,
    exit_status: session.status,
    summary: session.prompt?.slice(0, 200),
    meta: session.meta ?? {},
    timestamp: new Date().toISOString(),
  };
}

/**
 * Compute HMAC-SHA256 signature for a payload.
 */
export function computeSignature(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Fire-and-forget webhook POST. Logs errors but never throws.
 */
export async function emitWebhook(
  webhookConfig: WebhookConfig,
  payload: WebhookPayload,
): Promise<void> {
  try {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (webhookConfig.secret) {
      headers["X-Agentctl-Signature"] = computeSignature(
        body,
        webhookConfig.secret,
      );
    }

    // Use global fetch (available in Node 18+)
    await fetch(webhookConfig.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error(
      `[webhook] Failed to emit to ${webhookConfig.url}: ${(err as Error).message}`,
    );
  }
}
