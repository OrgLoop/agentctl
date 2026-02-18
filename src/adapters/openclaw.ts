import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  AgentSession,
  LaunchOpts,
  LifecycleEvent,
  ListOpts,
  PeekOpts,
  StopOpts,
} from "../core/types.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:18789";

export interface OpenClawAdapterOpts {
  baseUrl?: string; // Default: http://127.0.0.1:18789
  authToken?: string; // Default: process.env.OPENCLAW_WEBHOOK_TOKEN
  /** Override for testing — replaces the real WebSocket RPC call */
  rpcCall?: RpcCallFn;
}

/**
 * Shape of a single RPC exchange: send method+params, get back the payload.
 * Injected in tests to avoid a real WebSocket connection.
 */
export type RpcCallFn = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/** Row returned by the gateway's `sessions.list` method */
export interface GatewaySessionRow {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  channel?: string;
  updatedAt: number | null;
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  modelProvider?: string;
}

/** Result envelope from `sessions.list` */
export interface SessionsListResult {
  ts: number;
  path: string;
  count: number;
  defaults: {
    modelProvider: string | null;
    model: string | null;
    contextTokens: number | null;
  };
  sessions: GatewaySessionRow[];
}

/** Single preview entry from `sessions.preview` */
export interface SessionsPreviewEntry {
  key: string;
  status: "ok" | "empty" | "missing" | "error";
  items: Array<{ role: string; text: string }>;
}

/** Result envelope from `sessions.preview` */
export interface SessionsPreviewResult {
  ts: number;
  previews: SessionsPreviewEntry[];
}

/**
 * OpenClaw adapter — reads session data from the OpenClaw gateway via
 * its WebSocket RPC protocol. Falls back gracefully when the gateway
 * is unreachable.
 */
export class OpenClawAdapter implements AgentAdapter {
  readonly id = "openclaw";
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly rpcCall: RpcCallFn;

  constructor(opts?: OpenClawAdapterOpts) {
    this.baseUrl = opts?.baseUrl || DEFAULT_BASE_URL;
    this.authToken =
      opts?.authToken || process.env.OPENCLAW_WEBHOOK_TOKEN || "";
    this.rpcCall = opts?.rpcCall || this.defaultRpcCall.bind(this);
  }

  async list(opts?: ListOpts): Promise<AgentSession[]> {
    let result: SessionsListResult;
    try {
      result = (await this.rpcCall("sessions.list", {
        includeDerivedTitles: true,
        includeLastMessage: true,
      })) as SessionsListResult;
    } catch {
      // Gateway unreachable — return empty
      return [];
    }

    let sessions = result.sessions.map((row) =>
      this.mapRowToSession(row, result.defaults),
    );

    if (opts?.status) {
      sessions = sessions.filter((s) => s.status === opts.status);
    }

    if (!opts?.all && !opts?.status) {
      sessions = sessions.filter(
        (s) => s.status === "running" || s.status === "idle",
      );
    }

    return sessions;
  }

  async peek(sessionId: string, opts?: PeekOpts): Promise<string> {
    const key = await this.resolveKey(sessionId);
    if (!key) throw new Error(`Session not found: ${sessionId}`);

    const limit = opts?.lines ?? 20;
    let result: SessionsPreviewResult;
    try {
      result = (await this.rpcCall("sessions.preview", {
        keys: [key],
        limit,
        maxChars: 4000,
      })) as SessionsPreviewResult;
    } catch (err) {
      throw new Error(
        `Failed to peek session ${sessionId}: ${(err as Error).message}`,
      );
    }

    const preview = result.previews?.[0];
    if (!preview || preview.status === "missing") {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (preview.items.length === 0) return "(no messages)";

    const assistantMessages = preview.items
      .filter((item) => item.role === "assistant")
      .map((item) => item.text);

    if (assistantMessages.length === 0) return "(no assistant messages)";

    return assistantMessages.slice(-limit).join("\n---\n");
  }

  async status(sessionId: string): Promise<AgentSession> {
    let result: SessionsListResult;
    try {
      result = (await this.rpcCall("sessions.list", {
        includeDerivedTitles: true,
        search: sessionId,
      })) as SessionsListResult;
    } catch (err) {
      throw new Error(
        `Failed to get status for ${sessionId}: ${(err as Error).message}`,
      );
    }

    const row = result.sessions.find(
      (s) =>
        s.sessionId === sessionId ||
        s.key === sessionId ||
        s.sessionId?.startsWith(sessionId) ||
        s.key.startsWith(sessionId),
    );

    if (!row) throw new Error(`Session not found: ${sessionId}`);

    return this.mapRowToSession(row, result.defaults);
  }

  async launch(_opts: LaunchOpts): Promise<AgentSession> {
    throw new Error("OpenClaw sessions cannot be launched via agent-ctl");
  }

  async stop(_sessionId: string, _opts?: StopOpts): Promise<void> {
    throw new Error("OpenClaw sessions cannot be stopped via agent-ctl");
  }

  async resume(sessionId: string, _message: string): Promise<void> {
    // OpenClaw sessions receive messages through their configured channels,
    // not through a direct CLI interface.
    throw new Error(
      `Cannot resume OpenClaw session ${sessionId} — use the gateway UI or configured channel`,
    );
  }

  async *events(): AsyncIterable<LifecycleEvent> {
    // Poll-based diffing (same pattern as claude-code)
    let knownSessions = new Map<string, AgentSession>();

    // Initial snapshot
    const initial = await this.list({ all: true });
    for (const s of initial) {
      knownSessions.set(s.id, s);
    }

    while (true) {
      await sleep(5000);

      let current: AgentSession[];
      try {
        current = await this.list({ all: true });
      } catch {
        continue;
      }

      const currentMap = new Map(current.map((s) => [s.id, s]));

      for (const [id, session] of currentMap) {
        const prev = knownSessions.get(id);
        if (!prev) {
          yield {
            type: "session.started",
            adapter: this.id,
            sessionId: id,
            session,
            timestamp: new Date(),
          };
        } else if (prev.status === "running" && session.status === "stopped") {
          yield {
            type: "session.stopped",
            adapter: this.id,
            sessionId: id,
            session,
            timestamp: new Date(),
          };
        } else if (prev.status === "running" && session.status === "idle") {
          yield {
            type: "session.idle",
            adapter: this.id,
            sessionId: id,
            session,
            timestamp: new Date(),
          };
        }
      }

      knownSessions = currentMap;
    }
  }

  // --- Private helpers ---

  /**
   * Map a gateway session row to the standard AgentSession interface.
   * OpenClaw sessions with a recent updatedAt are considered "running".
   */
  private mapRowToSession(
    row: GatewaySessionRow,
    defaults: SessionsListResult["defaults"],
  ): AgentSession {
    const now = Date.now();
    const updatedAt = row.updatedAt ?? 0;
    const ageMs = now - updatedAt;

    // Consider "running" if updated in the last 5 minutes
    const isActive = updatedAt > 0 && ageMs < 5 * 60 * 1000;

    const model = row.model || defaults.model || undefined;
    const input = row.inputTokens ?? 0;
    const output = row.outputTokens ?? 0;

    return {
      id: row.sessionId || row.key,
      adapter: this.id,
      status: isActive ? "running" : "idle",
      startedAt: updatedAt > 0 ? new Date(updatedAt) : new Date(),
      cwd: undefined,
      model,
      prompt: row.derivedTitle || row.displayName || row.label,
      tokens: input || output ? { in: input, out: output } : undefined,
      meta: {
        key: row.key,
        kind: row.kind,
        channel: row.channel,
        displayName: row.displayName,
        modelProvider: row.modelProvider || defaults.modelProvider,
        lastMessagePreview: row.lastMessagePreview,
      },
    };
  }

  /**
   * Resolve a sessionId (or prefix) to a gateway session key.
   */
  private async resolveKey(sessionId: string): Promise<string | null> {
    let result: SessionsListResult;
    try {
      result = (await this.rpcCall("sessions.list", {
        search: sessionId,
      })) as SessionsListResult;
    } catch {
      return null;
    }

    const row = result.sessions.find(
      (s) =>
        s.sessionId === sessionId ||
        s.key === sessionId ||
        s.sessionId?.startsWith(sessionId) ||
        s.key.startsWith(sessionId),
    );

    return row?.key ?? null;
  }

  /**
   * Real WebSocket RPC call — connects, performs handshake, sends one
   * request, reads the response, then disconnects.
   */
  private async defaultRpcCall(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // Dynamic import so tests can inject a mock without loading ws
    const { WebSocket } = await import("ws" as string).catch(() => {
      // Fall back to globalThis.WebSocket (available in Node 22+)
      return { WebSocket: globalThis.WebSocket };
    });

    const wsUrl = this.baseUrl.replace(/^http/, "ws");
    const ws = new WebSocket(wsUrl);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("OpenClaw gateway connection timed out"));
      }, 10_000);

      const reqId = randomUUID();
      let connected = false;

      ws.onopen = () => {
        // Wait for challenge event, then send connect
      };

      ws.onmessage = (event: { data: unknown }) => {
        try {
          const raw =
            typeof event.data === "string" ? event.data : String(event.data);
          const frame = JSON.parse(raw);

          // Step 1: Receive challenge, send connect
          if (frame.type === "event" && frame.event === "connect.challenge") {
            ws.send(
              JSON.stringify({
                type: "req",
                id: randomUUID(),
                method: "connect",
                params: {
                  minProtocol: 1,
                  maxProtocol: 1,
                  client: {
                    id: "agent-ctl",
                    version: "0.1.0",
                    platform: process.platform,
                    mode: "cli",
                  },
                  role: "operator",
                  scopes: ["operator.read"],
                  auth: { token: this.authToken || null },
                },
              }),
            );
            return;
          }

          // Step 2: Receive hello-ok, send actual RPC
          if (frame.type === "res" && frame.ok && !connected) {
            connected = true;
            ws.send(
              JSON.stringify({
                type: "req",
                id: reqId,
                method,
                params,
              }),
            );
            return;
          }

          // Step 3: Receive RPC response
          if (frame.type === "res" && frame.id === reqId) {
            clearTimeout(timeout);
            ws.close();
            if (frame.ok) {
              resolve(frame.payload);
            } else {
              reject(new Error(frame.error?.message || `RPC error: ${method}`));
            }
            return;
          }

          // Auth failure
          if (frame.type === "res" && !frame.ok && !connected) {
            clearTimeout(timeout);
            ws.close();
            reject(
              new Error(frame.error?.message || "OpenClaw gateway auth failed"),
            );
          }
        } catch {
          // Ignore malformed frames
        }
      };

      ws.onerror = (err: unknown) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `OpenClaw gateway error: ${(err as Error)?.message || "connection failed"}`,
          ),
        );
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        // Only reject if we haven't resolved yet
      };
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
