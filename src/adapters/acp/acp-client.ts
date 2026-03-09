/**
 * ACP Client — wraps the ACP SDK's ClientSideConnection for agentctl's needs.
 *
 * Spawns an ACP-compatible agent binary as a child process, connects via
 * stdio using ndjson, and provides launch/prompt/cancel/status operations.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  type Agent,
  type Client,
  ClientSideConnection,
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { buildSpawnEnv } from "../../utils/daemon-env.js";
import { resolveBinaryPath } from "../../utils/resolve-binary.js";

/** Collected output from an ACP session */
export interface AcpSessionOutput {
  messages: string[];
  toolCalls: Array<{ name: string }>;
}

/** Permission policy for headless operation */
export type PermissionPolicy = "auto-approve" | "deny";

/** Configuration for spawning an ACP agent */
export interface AcpAgentConfig {
  /** Command to spawn (e.g. "codex-acp", "claude-code-acp") */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Human-readable name for this agent type */
  name: string;
}

/** Options for creating an ACP session */
export interface AcpLaunchOpts {
  cwd: string;
  env?: Record<string, string>;
  permissionPolicy?: PermissionPolicy;
}

/** Live ACP session state */
export interface AcpSession {
  sessionId: string;
  agentConfig: AcpAgentConfig;
  cwd: string;
  pid?: number;
  status: "connected" | "prompting" | "idle" | "disconnected";
  output: AcpSessionOutput;
  startedAt: Date;
  stoppedAt?: Date;
  lastStopReason?: StopReason;
}

/**
 * AcpClient manages the lifecycle of an ACP agent process and connection.
 *
 * Usage:
 *   const client = new AcpClient(agentConfig);
 *   const session = await client.connect({ cwd: "/my/project" });
 *   await client.prompt(session.sessionId, "Fix the bug in main.ts");
 *   await client.cancel(session.sessionId);
 *   client.disconnect();
 */
export class AcpClient {
  private child: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private sessions = new Map<string, AcpSession>();
  private readonly agentConfig: AcpAgentConfig;
  private permissionPolicy: PermissionPolicy = "auto-approve";

  constructor(agentConfig: AcpAgentConfig) {
    this.agentConfig = agentConfig;
  }

  /** Spawn the agent process and establish the ACP connection. */
  async connect(opts: AcpLaunchOpts): Promise<AcpSession> {
    this.permissionPolicy = opts.permissionPolicy ?? "auto-approve";

    const commandPath = await resolveBinaryPath(this.agentConfig.command);
    const args = this.agentConfig.args ?? [];
    const env = buildSpawnEnv(opts.env);

    this.child = spawn(commandPath, args, {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!this.child.stdin || !this.child.stdout) {
      throw new Error(
        `Failed to spawn ACP agent: ${this.agentConfig.command} — no stdio`,
      );
    }

    const pid = this.child.pid;

    // Convert Node streams to web streams for ACP SDK
    const writable = nodeWritableToWeb(this.child.stdin);
    const readable = nodeReadableToWeb(this.child.stdout);
    const stream = ndJsonStream(writable, readable);

    // Create the client-side connection
    this.connection = new ClientSideConnection(
      (_agent: Agent) => this.createClient(),
      stream,
    );

    // Initialize the ACP connection
    await this.connection.initialize({
      clientCapabilities: {
        terminal: true,
      },
      clientInfo: { name: "agentctl", version: "1.0.0" },
      protocolVersion: 1,
    });

    // Create a new session
    const response = await this.connection.newSession({
      cwd: opts.cwd,
      mcpServers: [],
    });

    const session: AcpSession = {
      sessionId: response.sessionId,
      agentConfig: this.agentConfig,
      cwd: opts.cwd,
      pid,
      status: "idle",
      output: { messages: [], toolCalls: [] },
      startedAt: new Date(),
    };

    this.sessions.set(response.sessionId, session);

    // Track process exit
    this.child.on("exit", () => {
      for (const s of this.sessions.values()) {
        if (s.status !== "disconnected") {
          s.status = "disconnected";
          s.stoppedAt = new Date();
        }
      }
    });

    return session;
  }

  /** Send a prompt to an existing session. Returns when the turn completes. */
  async prompt(sessionId: string, text: string): Promise<StopReason> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown ACP session: ${sessionId}`);
    if (!this.connection) throw new Error("ACP connection not established");

    session.status = "prompting";

    const response = await this.connection.prompt({
      sessionId,
      prompt: [{ type: "text", text }],
    });

    session.status = "idle";
    session.lastStopReason = response.stopReason;
    return response.stopReason;
  }

  /** Send a prompt without waiting for completion (fire-and-forget for launch). */
  promptDetached(sessionId: string, text: string): void {
    this.prompt(sessionId, text).catch(() => {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.status = "disconnected";
        session.stoppedAt = new Date();
      }
    });
  }

  /** Cancel an ongoing prompt turn. */
  async cancel(sessionId: string): Promise<void> {
    if (!this.connection) return;
    await this.connection.cancel({ sessionId });
  }

  /** Get session state. */
  getSession(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Get all sessions managed by this client. */
  getAllSessions(): AcpSession[] {
    return [...this.sessions.values()];
  }

  /** Check if the agent process is still running. */
  isAlive(): boolean {
    if (!this.child?.pid) return false;
    try {
      process.kill(this.child.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Disconnect from the agent and kill the process. */
  disconnect(): void {
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // Already dead
      }
      this.child = null;
    }
    this.connection = null;

    for (const session of this.sessions.values()) {
      if (session.status !== "disconnected") {
        session.status = "disconnected";
        session.stoppedAt = new Date();
      }
    }
  }

  /** Force kill the agent process. */
  forceKill(): void {
    if (this.child) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // Already dead
      }
      this.child = null;
    }
    this.connection = null;

    for (const session of this.sessions.values()) {
      if (session.status !== "disconnected") {
        session.status = "disconnected";
        session.stoppedAt = new Date();
      }
    }
  }

  /** Get the output collected from a session. */
  getOutput(sessionId: string): AcpSessionOutput | undefined {
    return this.sessions.get(sessionId)?.output;
  }

  /** Create the ACP Client handler for the connection. */
  private createClient(): Client {
    return {
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        if (this.permissionPolicy === "auto-approve") {
          // Auto-approve: select the first allow option
          const approveOption = params.options.find(
            (o) => o.kind === "allow_once" || o.kind === "allow_always",
          );
          return {
            outcome: {
              outcome: "selected",
              optionId: approveOption?.optionId ?? params.options[0].optionId,
            },
          };
        }
        // Deny policy: cancel permissions
        return { outcome: { outcome: "cancelled" } };
      },

      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        const session = this.sessions.get(params.sessionId);
        if (!session) return;

        const update = params.update as SessionUpdate;
        if (!update) return;

        if (
          update.sessionUpdate === "agent_message_chunk" &&
          "text" in update
        ) {
          // Accumulate agent text output
          const text = (update as unknown as { text: string }).text;
          if (text) {
            const msgs = session.output.messages;
            if (msgs.length === 0) {
              msgs.push(text);
            } else {
              // Append to last message (streaming chunks)
              msgs[msgs.length - 1] += text;
            }
          }
        }

        if (update.sessionUpdate === "tool_call" && "name" in update) {
          session.output.toolCalls.push({
            name: (update as unknown as { name: string }).name,
          });
        }
      },
    };
  }
}

// --- Node-to-Web stream adapters ---

function nodeWritableToWeb(nodeStream: Writable): WritableStream<Uint8Array> {
  return new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        const ok = nodeStream.write(chunk, (err) => {
          if (err) reject(err);
        });
        if (ok) resolve();
        else nodeStream.once("drain", resolve);
      });
    },
    close() {
      return new Promise((resolve) => {
        nodeStream.end(resolve);
      });
    },
    abort() {
      nodeStream.destroy();
    },
  });
}

function nodeReadableToWeb(nodeStream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      nodeStream.on("end", () => {
        controller.close();
      });
      nodeStream.on("error", (err) => {
        controller.error(err);
      });
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}
