// agentctl core types — Universal Agent Supervision Interface

/**
 * Session discovered by an adapter's runtime — the ground truth for "what exists."
 * This is the source of truth for session lifecycle in the discover-first model.
 */
export interface DiscoveredSession {
  id: string;
  status: "running" | "stopped";
  adapter: string;
  cwd?: string;
  model?: string;
  startedAt?: Date;
  stoppedAt?: Date;
  pid?: number;
  prompt?: string;
  tokens?: { in: number; out: number };
  cost?: number;
  /** Adapter-native fields — whatever the runtime provides */
  nativeMetadata?: Record<string, unknown>;
}

export interface AgentAdapter {
  id: string; // "claude-code", "openclaw", etc.

  // Discover-first: ground truth from adapter runtime
  /** Find all sessions currently managed by this adapter's runtime. */
  discover(): Promise<DiscoveredSession[]>;
  /** Check if a specific session is still alive. */
  isAlive(sessionId: string): Promise<boolean>;

  // Legacy discovery (delegates to discover() with filtering)
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
  group?: string; // launch group tag, e.g. "g-a1b2c3"
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
  /** Git worktree options — auto-create worktree before launch */
  worktree?: { repo: string; branch: string };
  /** Lifecycle hooks — shell commands to run at various points */
  hooks?: LifecycleHooks;
}

export interface LifecycleHooks {
  onCreate?: string;
  onComplete?: string;
}
