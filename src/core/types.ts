// agent-ctl core types — Universal Agent Supervision Interface

export interface AgentAdapter {
  id: string; // "claude-code", "openclaw", etc.

  // Discovery
  list(opts?: ListOpts): Promise<AgentSession[]>;

  // Read
  peek(sessionId: string, opts?: PeekOpts): Promise<string>;
  status(sessionId: string): Promise<AgentSession>;

  // Control
  launch(opts: LaunchOpts): Promise<AgentSession>;
  stop(sessionId: string, opts?: StopOpts): Promise<void>;
  resume(sessionId: string, message: string): Promise<void>;

  // Lifecycle events
  events(): AsyncIterable<LifecycleEvent>;
}

export interface AgentSession {
  id: string;
  adapter: string;
  status: "running" | "idle" | "stopped" | "error";
  startedAt: Date;
  stoppedAt?: Date;
  cwd?: string;
  spec?: string;
  model?: string;
  prompt?: string;
  tokens?: { in: number; out: number };
  cost?: number;
  pid?: number;
  meta: Record<string, unknown>;
}

export interface LifecycleEvent {
  type:
    | "session.started"
    | "session.stopped"
    | "session.idle"
    | "session.error";
  adapter: string;
  sessionId: string;
  session: AgentSession;
  timestamp: Date;
  meta?: Record<string, unknown>;
}

export interface ListOpts {
  status?: "running" | "idle" | "stopped" | "error";
  all?: boolean; // include stopped sessions (default: running only)
}

export interface PeekOpts {
  lines?: number;
}

export interface StopOpts {
  force?: boolean;
}

export interface LaunchOpts {
  adapter: string;
  prompt: string;
  spec?: string;
  cwd?: string;
  model?: string;
  env?: Record<string, string>;
  adapterOpts?: Record<string, unknown>;
}
