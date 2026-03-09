/**
 * ACP Adapter — generic AgentAdapter implementation backed by ACP.
 *
 * This adapter delegates launch/resume/lifecycle to an ACP agent process
 * (via AcpClient) instead of bespoke PTY scraping. It is designed to be
 * reusable across agent runtimes — configure it with an AcpAgentConfig
 * for Codex, Claude Code, OpenCode, etc.
 */
import type {
  AgentAdapter,
  AgentSession,
  DiscoveredSession,
  LaunchOpts,
  LifecycleEvent,
  ListOpts,
  PeekOpts,
  StopOpts,
} from "../../core/types.js";
import {
  type AcpAgentConfig,
  AcpClient,
  type AcpLaunchOpts,
  type AcpSession,
  type PermissionPolicy,
} from "./acp-client.js";

export interface AcpAdapterOpts {
  /** ACP agent configuration (command, args, name) */
  agentConfig: AcpAgentConfig;
  /** Default permission policy for headless mode */
  permissionPolicy?: PermissionPolicy;
  /** Factory for creating AcpClient instances (injectable for testing) */
  createClient?: (config: AcpAgentConfig) => AcpClient;
}

/**
 * Generic ACP-backed adapter. Manages one AcpClient per active session.
 * Multiple sessions can be running concurrently (each in its own process).
 */
export class AcpAdapter implements AgentAdapter {
  readonly id: string;
  private readonly agentConfig: AcpAgentConfig;
  private readonly permissionPolicy: PermissionPolicy;
  private readonly createClient: (config: AcpAgentConfig) => AcpClient;

  /** Active clients keyed by session ID */
  private clients = new Map<string, AcpClient>();

  constructor(adapterId: string, opts: AcpAdapterOpts) {
    this.id = adapterId;
    this.agentConfig = opts.agentConfig;
    this.permissionPolicy = opts.permissionPolicy ?? "auto-approve";
    this.createClient =
      opts.createClient ?? ((config) => new AcpClient(config));
  }

  async discover(): Promise<DiscoveredSession[]> {
    const results: DiscoveredSession[] = [];
    for (const [, client] of this.clients) {
      for (const session of client.getAllSessions()) {
        results.push(this.toDiscoveredSession(session));
      }
    }
    return results;
  }

  async isAlive(sessionId: string): Promise<boolean> {
    const client = this.clients.get(sessionId);
    if (!client) return false;
    const session = client.getSession(sessionId);
    return session?.status !== "disconnected";
  }

  async list(opts?: ListOpts): Promise<AgentSession[]> {
    const discovered = await this.discover();
    return discovered
      .filter((d) => {
        if (opts?.status) return d.status === opts.status;
        if (opts?.all) return true;
        return d.status === "running";
      })
      .map((d) => this.toAgentSession(d));
  }

  async peek(sessionId: string, opts?: PeekOpts): Promise<string> {
    const client = this.clients.get(sessionId);
    if (!client) throw new Error(`Session not found: ${sessionId}`);

    const output = client.getOutput(sessionId);
    if (!output) return "";

    const lines = opts?.lines ?? 20;
    const recent = output.messages.slice(-lines);
    return recent.join("\n---\n");
  }

  async status(sessionId: string): Promise<AgentSession> {
    const client = this.clients.get(sessionId);
    if (!client) throw new Error(`Session not found: ${sessionId}`);

    const session = client.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    return this.toAgentSession(this.toDiscoveredSession(session));
  }

  async launch(opts: LaunchOpts): Promise<AgentSession> {
    const client = this.createClient(this.agentConfig);
    const cwd = opts.cwd || process.cwd();

    const launchOpts: AcpLaunchOpts = {
      cwd,
      env: opts.env,
      permissionPolicy: this.permissionPolicy,
    };

    const session = await client.connect(launchOpts);
    this.clients.set(session.sessionId, client);

    // Send the prompt without blocking (fire-and-forget)
    client.promptDetached(session.sessionId, opts.prompt);

    return {
      id: session.sessionId,
      adapter: this.id,
      status: "running",
      startedAt: session.startedAt,
      cwd,
      model: opts.model,
      prompt: opts.prompt.slice(0, 200),
      pid: session.pid,
      meta: {
        transport: "acp",
        agentCommand: this.agentConfig.command,
        adapterOpts: opts.adapterOpts,
        spec: opts.spec,
      },
    };
  }

  async stop(sessionId: string, opts?: StopOpts): Promise<void> {
    const client = this.clients.get(sessionId);
    if (!client) throw new Error(`No active session: ${sessionId}`);

    if (opts?.force) {
      client.forceKill();
    } else {
      // Try cooperative cancel first, then disconnect
      try {
        await client.cancel(sessionId);
      } catch {
        // Cancel may fail if already disconnected
      }
      client.disconnect();
    }

    this.clients.delete(sessionId);
  }

  async resume(sessionId: string, message: string): Promise<void> {
    const client = this.clients.get(sessionId);
    if (!client) throw new Error(`No active session: ${sessionId}`);

    client.promptDetached(sessionId, message);
  }

  async *events(): AsyncIterable<LifecycleEvent> {
    const knownStatuses = new Map<string, string>();

    while (true) {
      await sleep(5000);

      for (const [sessionId, client] of this.clients) {
        const session = client.getSession(sessionId);
        if (!session) continue;

        const prevStatus = knownStatuses.get(sessionId);
        const currentStatus =
          session.status === "disconnected" ? "stopped" : "running";

        if (prevStatus && prevStatus !== currentStatus) {
          const discovered = this.toDiscoveredSession(session);
          yield {
            type:
              currentStatus === "stopped"
                ? "session.stopped"
                : "session.started",
            adapter: this.id,
            sessionId,
            session: this.toAgentSession(discovered),
            timestamp: new Date(),
          };
        }

        knownStatuses.set(sessionId, currentStatus);
      }

      // Clean up dead sessions from tracking
      for (const [id] of knownStatuses) {
        if (!this.clients.has(id)) {
          knownStatuses.delete(id);
        }
      }
    }
  }

  // --- Helpers ---

  private toDiscoveredSession(session: AcpSession): DiscoveredSession {
    const isRunning = session.status !== "disconnected";
    return {
      id: session.sessionId,
      status: isRunning ? "running" : "stopped",
      adapter: this.id,
      cwd: session.cwd,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      pid: session.pid,
      nativeMetadata: {
        transport: "acp",
        agentCommand: session.agentConfig.command,
        acpStatus: session.status,
        lastStopReason: session.lastStopReason,
      },
    };
  }

  private toAgentSession(discovered: DiscoveredSession): AgentSession {
    return {
      id: discovered.id,
      adapter: this.id,
      status: discovered.status === "running" ? "running" : "stopped",
      startedAt: discovered.startedAt ?? new Date(),
      stoppedAt: discovered.stoppedAt,
      cwd: discovered.cwd,
      pid: discovered.pid,
      prompt: discovered.prompt,
      tokens: discovered.tokens,
      meta: discovered.nativeMetadata ?? {},
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
