import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type {
  AgentAdapter,
  AgentSession,
  DiscoveredSession,
  LaunchOpts,
  LifecycleEvent,
  ListOpts,
  PeekOpts,
  StopOpts,
} from "../core/types.js";
import { buildSpawnEnv } from "../utils/daemon-env.js";
import {
  cleanupPromptFile,
  isLargePrompt,
  openPromptFd,
  writePromptFile,
} from "../utils/prompt-file.js";
import { resolveBinaryPath } from "../utils/resolve-binary.js";
import {
  cleanupExpiredMeta,
  deleteSessionMeta,
  type LaunchedSessionMeta,
  readSessionMeta,
  writeSessionMeta,
} from "../utils/session-meta.js";

const execFileAsync = promisify(execFile);

const DEFAULT_STORAGE_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "opencode",
  "storage",
);

// Default: only show stopped sessions from the last 7 days
const STOPPED_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default master timeout: 3 hours */
const DEFAULT_MASTER_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/** PID poll interval: 15 seconds */
const POLL_INTERVAL_MS = 15_000;

export interface PidInfo {
  pid: number;
  cwd: string;
  args: string;
  /** Process start time from `ps -p <pid> -o lstart=`, used to detect PID recycling */
  startTime?: string;
}

// Re-export from shared utility for backward compat
export type { LaunchedSessionMeta } from "../utils/session-meta.js";

/** Shape of an OpenCode session JSON file */
export interface OpenCodeSessionFile {
  id: string;
  slug?: string;
  version?: string;
  projectID?: string;
  directory?: string;
  title?: string;
  time?: {
    created?: number | string;
    updated?: number | string;
  };
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
  };
}

/** Shape of an OpenCode message JSON file */
export interface OpenCodeMessageFile {
  id: string;
  sessionID?: string;
  role?: "user" | "assistant";
  time?: {
    created?: number | string;
    completed?: number | string;
  };
  agent?: string;
  model?: {
    providerID?: string;
    modelID?: string;
  };
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
  };
  cache?: {
    read?: number;
    write?: number;
  };
  cost?: number;
  finish?: string;
  error?: {
    name?: string;
    data?: { message?: string };
  };
  modelID?: string;
  providerID?: string;
}

/** Per-session fuse state — tracks the three lifecycle signals */
export interface SessionFuse {
  sessionId: string;
  pid: number;
  exitFilePath: string;
  launchedAt: Date;
  timeoutMs: number;
  abortController: AbortController;
  /** Cached session object for event emission */
  session: AgentSession;
}

export interface OpenCodeAdapterOpts {
  storageDir?: string; // Override ~/.local/share/opencode/storage for testing
  sessionsMetaDir?: string; // Override metadata dir for testing
  getPids?: () => Promise<Map<number, PidInfo>>; // Override PID detection for testing
  /** Override PID liveness check for testing (default: process.kill(pid, 0)) */
  isProcessAlive?: (pid: number) => boolean;
  /** Override master timeout for testing (default: 3h) */
  masterTimeoutMs?: number;
  /** Override poll interval for testing (default: 15s) */
  pollIntervalMs?: number;
}

/**
 * Compute the project hash matching OpenCode's approach: SHA1 of the directory path.
 */
export function computeProjectHash(directory: string): string {
  return crypto.createHash("sha1").update(directory).digest("hex");
}

/**
 * Generate a wrapper shell script that runs opencode and writes exit code to a file.
 * This gives us immediate exit code capture — the primary signal in the fuse.
 */
export function generateWrapperScript(
  opencodeBin: string,
  args: string[],
  exitFilePath: string,
): string {
  // Shell-escape each arg: wrap in single quotes, escape embedded single quotes
  const escapedArgs = args
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(" ");
  return [
    "#!/bin/sh",
    `${opencodeBin} ${escapedArgs}`,
    `EC=$?`,
    `echo "$EC" > '${exitFilePath.replace(/'/g, "'\\''")}'`,
    `exit $EC`,
  ].join("\n");
}

/**
 * OpenCode adapter — reads session data from ~/.local/share/opencode/storage/
 * and cross-references with running opencode processes.
 *
 * Implements three-prong session lifecycle fuse:
 * 1. Wrapper exit hook (writes .exit file with exit code)
 * 2. PID death poll (kill(pid,0) every 15s)
 * 3. Master timeout (configurable, default 3h)
 * First signal to fire cancels the others via AbortController.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly id = "opencode";
  private readonly storageDir: string;
  private readonly sessionDir: string;
  private readonly messageDir: string;
  private readonly sessionsMetaDir: string;
  private readonly getPids: () => Promise<Map<number, PidInfo>>;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly masterTimeoutMs: number;
  private readonly pollIntervalMs: number;

  /** Active fuses for launched sessions — keyed by sessionId */
  private readonly fuses = new Map<string, SessionFuse>();

  /** Session IDs that have already fired a fuse event — prevents re-emission by legacy poll */
  private readonly firedFuseIds = new Set<string>();

  constructor(opts?: OpenCodeAdapterOpts) {
    this.storageDir = opts?.storageDir || DEFAULT_STORAGE_DIR;
    this.sessionDir = path.join(this.storageDir, "session");
    this.messageDir = path.join(this.storageDir, "message");
    this.sessionsMetaDir =
      opts?.sessionsMetaDir ||
      path.join(os.homedir(), ".agentctl", "opencode-sessions");
    this.getPids = opts?.getPids || getOpenCodePids;
    this.isProcessAlive = opts?.isProcessAlive || defaultIsProcessAlive;
    this.masterTimeoutMs = opts?.masterTimeoutMs ?? DEFAULT_MASTER_TIMEOUT_MS;
    this.pollIntervalMs = opts?.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  async discover(): Promise<DiscoveredSession[]> {
    cleanupExpiredMeta(this.sessionsMetaDir).catch(() => {});
    const runningPids = await this.getPids();
    const results: DiscoveredSession[] = [];

    let projectDirs: string[];
    try {
      projectDirs = await fs.readdir(this.sessionDir);
    } catch {
      return [];
    }

    for (const projHash of projectDirs) {
      const projPath = path.join(this.sessionDir, projHash);
      const stat = await fs.stat(projPath).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const sessionFiles = await this.getSessionFilesForProject(projPath);

      for (const sessionData of sessionFiles) {
        const isRunning = await this.isSessionRunning(sessionData, runningPids);
        const { model, tokens, cost } = await this.aggregateMessageStats(
          sessionData.id,
        );

        const createdAt = sessionData.time?.created
          ? new Date(sessionData.time.created)
          : new Date();
        const updatedAt = sessionData.time?.updated
          ? new Date(sessionData.time.updated)
          : undefined;

        results.push({
          id: sessionData.id,
          status: isRunning ? "running" : "stopped",
          adapter: this.id,
          cwd: sessionData.directory,
          model,
          startedAt: createdAt,
          stoppedAt: isRunning ? undefined : updatedAt,
          pid: isRunning
            ? await this.findMatchingPid(sessionData, runningPids)
            : undefined,
          prompt: sessionData.title?.slice(0, 200),
          tokens,
          cost,
          nativeMetadata: {
            projectID: sessionData.projectID,
            slug: sessionData.slug,
            summary: sessionData.summary,
            version: sessionData.version,
          },
        });
      }
    }

    return results;
  }

  async isAlive(sessionId: string): Promise<boolean> {
    const runningPids = await this.getPids();
    const resolved = await this.resolveSessionId(sessionId);
    if (!resolved) return false;
    return this.isSessionRunning(resolved, runningPids);
  }

  async list(opts?: ListOpts): Promise<AgentSession[]> {
    const runningPids = await this.getPids();
    const sessions: AgentSession[] = [];
    const seenIds = new Set<string>();

    // Primary source: opencode's native storage (has rich metadata + PID recycling)
    await this.listFromNativeStorage(sessions, seenIds, runningPids, opts);

    // Supplementary: meta dir for agentctl-launched sessions not in native storage
    await this.listFromMetaDir(sessions, seenIds, runningPids, opts);

    // Sort: running first, then by most recent
    sessions.sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;
      return b.startedAt.getTime() - a.startedAt.getTime();
    });

    return sessions;
  }

  async peek(sessionId: string, opts?: PeekOpts): Promise<string> {
    const lines = opts?.lines ?? 20;
    const resolved = await this.resolveSessionId(sessionId);
    if (!resolved) throw new Error(`Session not found: ${sessionId}`);

    const messages = await this.readMessages(resolved.id);

    // Filter to assistant messages first, then take only the last N
    // before reading parts — avoids O(M*P) file reads for long sessions
    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    const recentMsgs = assistantMsgs.slice(-lines);

    const assistantMessages: string[] = [];
    for (const msg of recentMsgs) {
      const text = await this.readMessageParts(msg.id);
      if (text) {
        assistantMessages.push(text);
      } else if (msg.error?.data?.message) {
        assistantMessages.push(`[error] ${msg.error.data.message}`);
      }
    }

    return assistantMessages.join("\n---\n");
  }

  async status(sessionId: string): Promise<AgentSession> {
    const resolved = await this.resolveSessionId(sessionId);
    if (!resolved) throw new Error(`Session not found: ${sessionId}`);

    // Lightweight status: avoid expensive getOpenCodePids() (ps aux + lsof per process).
    // Instead, check persisted metadata PID and recent-update heuristic.
    const isRunning = await this.isSessionRunningLightweight(resolved);
    const { model, tokens, cost } = await this.aggregateMessageStats(
      resolved.id,
    );

    const createdAt = resolved.time?.created
      ? new Date(resolved.time.created)
      : new Date();
    const updatedAt = resolved.time?.updated
      ? new Date(resolved.time.updated)
      : undefined;

    let pid: number | undefined;
    if (isRunning) {
      const meta = await readSessionMeta(this.sessionsMetaDir, resolved.id);
      if (meta?.pid && this.isProcessAlive(meta.pid)) {
        pid = meta.pid;
      }
    }

    return {
      id: resolved.id,
      adapter: this.id,
      status: isRunning ? "running" : "stopped",
      startedAt: createdAt,
      stoppedAt: isRunning ? undefined : updatedAt,
      cwd: resolved.directory,
      model,
      prompt: resolved.title?.slice(0, 200),
      tokens,
      cost,
      pid,
      meta: {
        projectID: resolved.projectID,
        slug: resolved.slug,
        summary: resolved.summary,
        version: resolved.version,
      },
    };
  }

  async launch(opts: LaunchOpts): Promise<AgentSession> {
    const args = ["run"];
    if (opts.model) {
      args.push("--model", opts.model);
    }

    // For large prompts, pipe via stdin instead of CLI args to avoid
    // OS argv size limits (ARG_MAX).
    const useTempFile = isLargePrompt(opts.prompt);
    let promptFilePath: string | undefined;
    let promptFd: Awaited<ReturnType<typeof openPromptFd>> | undefined;

    if (useTempFile) {
      promptFilePath = await writePromptFile(opts.prompt);
      promptFd = await openPromptFd(promptFilePath);
    } else {
      // Use -- separator to prevent prompts starting with dashes (e.g. YAML
      // frontmatter "---") from being interpreted as CLI options by opencode.
      args.push("--", opts.prompt);
    }

    const env = buildSpawnEnv(opts.env);
    const cwd = opts.cwd || process.cwd();

    await fs.mkdir(this.sessionsMetaDir, { recursive: true });

    const sessionId = crypto.randomUUID();
    const exitFilePath = path.join(this.sessionsMetaDir, `${sessionId}.exit`);

    // Write stdout/stderr to a log file so we don't keep pipes open
    // (which would prevent full detachment of the child process).
    const logPath = path.join(this.sessionsMetaDir, `launch-${Date.now()}.log`);
    const logFd = await fs.open(logPath, "w");

    // Generate wrapper script that captures exit code
    const opencodeBin = await resolveBinaryPath("opencode");
    const wrapperScript = generateWrapperScript(
      opencodeBin,
      args,
      exitFilePath,
    );
    const wrapperPath = path.join(
      this.sessionsMetaDir,
      `wrapper-${sessionId}.sh`,
    );
    await fs.writeFile(wrapperPath, wrapperScript, { mode: 0o755 });

    const child = spawn("/bin/sh", [wrapperPath], {
      cwd,
      env,
      stdio: [promptFd ? promptFd.fd : "ignore", logFd.fd, logFd.fd],
      detached: true,
    });

    child.unref();

    const pid = child.pid;
    const now = new Date();

    // Close our handles — child keeps its own fds open
    await logFd.close();
    if (promptFd) await promptFd.close();
    if (promptFilePath) await cleanupPromptFile(promptFilePath);

    // Persist session metadata so status checks work after wrapper exits
    if (pid) {
      await writeSessionMeta(this.sessionsMetaDir, {
        sessionId,
        pid,
        cwd,
        model: opts.model,
        prompt: opts.prompt.slice(0, 200),
        adapter: this.id,
      });
    }

    const session: AgentSession = {
      id: sessionId,
      adapter: this.id,
      status: "running",
      startedAt: now,
      cwd,
      model: opts.model,
      prompt: opts.prompt.slice(0, 200),
      pid,
      meta: {
        adapterOpts: opts.adapterOpts,
        spec: opts.spec,
      },
    };

    // Register fuse for this session
    if (pid) {
      const timeoutMs = opts.timeout ?? this.masterTimeoutMs;
      const fuse: SessionFuse = {
        sessionId,
        pid,
        exitFilePath,
        launchedAt: now,
        timeoutMs,
        abortController: new AbortController(),
        session,
      };
      this.fuses.set(sessionId, fuse);
    }

    return session;
  }

  async stop(sessionId: string, opts?: StopOpts): Promise<void> {
    const pid = await this.findPidForSession(sessionId);
    if (!pid) throw new Error(`No running process for session: ${sessionId}`);

    if (opts?.force) {
      process.kill(pid, "SIGINT");
      await sleep(5000);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead — good
      }
    } else {
      process.kill(pid, "SIGTERM");
    }
  }

  async resume(sessionId: string, message: string): Promise<void> {
    // OpenCode doesn't have a native resume command — launch a new session
    // with the same working directory
    const resolved = await this.resolveSessionId(sessionId);
    if (!resolved)
      throw new Error(`Session not found for resume: ${sessionId}`);

    const cwd = resolved.directory || process.cwd();

    const opencodePath = await resolveBinaryPath("opencode");

    await fs.mkdir(this.sessionsMetaDir, { recursive: true });
    const logPath = path.join(this.sessionsMetaDir, `resume-${Date.now()}.log`);
    const logFd = await fs.open(logPath, "w");

    const child = spawn(opencodePath, ["run", message], {
      cwd,
      stdio: ["ignore", logFd.fd, logFd.fd],
      detached: true,
    });

    child.on("error", (err) => {
      console.error(`[opencode] resume spawn error: ${err.message}`);
    });

    child.unref();
    await logFd.close();
  }

  /**
   * Three-prong lifecycle fuse event generator.
   *
   * For each tracked session, checks three signals every poll cycle:
   * 1. Exit file exists → session.stopped with exit code
   * 2. PID dead (kill(pid,0) fails) → session.stopped with unknown exit code
   * 3. Master timeout exceeded → session.timeout
   *
   * First signal to fire cancels the others via AbortController.
   * Also falls back to the legacy poll for sessions not launched via agentctl.
   */
  async *events(): AsyncIterable<LifecycleEvent> {
    // Legacy tracking for sessions discovered from native storage
    let knownSessions = new Map<string, AgentSession>();

    const initial = await this.list({ all: true });
    for (const s of initial) {
      knownSessions.set(s.id, s);
    }

    // Poll + fs.watch hybrid for native storage
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      watcher = watch(this.sessionDir, { recursive: true });
    } catch {
      // Directory may not exist
    }

    try {
      while (true) {
        // Re-scan meta dir for newly launched sessions not yet tracked
        await this.bootstrapFusesFromMeta();

        // Check fuses for tracked sessions (three-prong)
        yield* this.checkFuses();

        // Sleep before next cycle
        await sleep(this.pollIntervalMs);

        // Legacy poll for native-storage sessions
        const current = await this.list({ all: true });
        const currentMap = new Map(current.map((s) => [s.id, s]));

        for (const [id, session] of currentMap) {
          // Skip sessions tracked by fuse — they're handled above
          if (this.fuses.has(id) || this.firedFuseIds.has(id)) continue;

          const prev = knownSessions.get(id);
          if (!prev) {
            yield {
              type: "session.started",
              adapter: this.id,
              sessionId: id,
              session,
              timestamp: new Date(),
            };
          } else if (
            prev.status === "running" &&
            session.status === "stopped"
          ) {
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
    } finally {
      watcher?.close();
      // Clean up any remaining fuses
      for (const fuse of this.fuses.values()) {
        fuse.abortController.abort();
      }
      this.fuses.clear();
    }
  }

  // --- Fuse management ---

  /**
   * Check all active fuses for signals. Yields events for any that fired.
   * First signal cancels the others (AbortController pattern).
   */
  private async *checkFuses(): AsyncIterable<LifecycleEvent> {
    for (const [sessionId, fuse] of this.fuses) {
      if (fuse.abortController.signal.aborted) {
        this.fuses.delete(sessionId);
        continue;
      }

      // Signal 1: Exit file exists (wrapper completed)
      const exitCode = await this.readExitFile(fuse.exitFilePath);
      if (exitCode !== null) {
        fuse.abortController.abort();
        this.fuses.delete(sessionId);
        this.firedFuseIds.add(sessionId);
        const session = {
          ...fuse.session,
          status: "stopped" as const,
          stoppedAt: new Date(),
        };
        yield {
          type: "session.stopped",
          adapter: this.id,
          sessionId,
          session,
          timestamp: new Date(),
          meta: { exitCode, signal: "exit-file" },
        };
        continue;
      }

      // Signal 2: PID death poll
      if (!this.isProcessAlive(fuse.pid)) {
        fuse.abortController.abort();
        this.fuses.delete(sessionId);
        this.firedFuseIds.add(sessionId);
        const session = {
          ...fuse.session,
          status: "stopped" as const,
          stoppedAt: new Date(),
        };
        yield {
          type: "session.stopped",
          adapter: this.id,
          sessionId,
          session,
          timestamp: new Date(),
          meta: { signal: "pid-death" },
        };
        continue;
      }

      // Signal 3: Master timeout
      const elapsed = Date.now() - fuse.launchedAt.getTime();
      if (elapsed >= fuse.timeoutMs) {
        fuse.abortController.abort();
        this.fuses.delete(sessionId);
        this.firedFuseIds.add(sessionId);
        yield {
          type: "session.timeout",
          adapter: this.id,
          sessionId,
          session: fuse.session,
          timestamp: new Date(),
          meta: { timeoutMs: fuse.timeoutMs, signal: "master-timeout" },
        };
      }
    }
  }

  /**
   * Bootstrap fuses for meta-dir sessions not yet tracked.
   * Called each poll cycle to pick up sessions launched between cycles.
   *
   * Creates fuses even for dead PIDs — checkFuses will immediately detect
   * the death and emit session.stopped on the next cycle.
   */
  private async bootstrapFusesFromMeta(): Promise<void> {
    let files: string[];
    try {
      files = await fs.readdir(this.sessionsMetaDir);
    } catch {
      return;
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const sessionId = file.replace(/\.json$/, "");

      // Skip if already tracked or already fired
      if (this.fuses.has(sessionId) || this.firedFuseIds.has(sessionId))
        continue;

      const meta = await readSessionMeta(this.sessionsMetaDir, sessionId);
      if (!meta?.pid) continue;

      // Create fuse if PID is alive or exit file exists.
      // If exit file exists, checkFuses will fire immediately on next cycle.
      // If PID is dead with no exit file, checkFuses detects that too.
      const exitFilePath = path.join(this.sessionsMetaDir, `${sessionId}.exit`);
      const hasExitFile = (await this.readExitFile(exitFilePath)) !== null;
      if (!hasExitFile && !this.isProcessAlive(meta.pid)) continue;

      const launchedAt = new Date(meta.launchedAt);

      const session: AgentSession = {
        id: sessionId,
        adapter: this.id,
        status: "running",
        startedAt: launchedAt,
        pid: meta.pid,
        cwd: meta.cwd,
        model: meta.model,
        prompt: meta.prompt,
        meta: { source: "meta-dir" },
      };

      this.fuses.set(sessionId, {
        sessionId,
        pid: meta.pid,
        exitFilePath,
        launchedAt,
        timeoutMs: this.masterTimeoutMs,
        abortController: new AbortController(),
        session,
      });
    }
  }

  /**
   * Read exit code from a .exit file. Returns null if file doesn't exist.
   */
  private async readExitFile(exitFilePath: string): Promise<number | null> {
    try {
      const content = await fs.readFile(exitFilePath, "utf-8");
      const code = parseInt(content.trim(), 10);
      return Number.isNaN(code) ? null : code;
    } catch {
      return null;
    }
  }

  // --- list() helpers ---

  /**
   * Enumerate sessions from the meta dir (agentctl-launched sessions).
   * This is the primary source — these sessions may not appear in native storage.
   */
  private async listFromMetaDir(
    sessions: AgentSession[],
    seenIds: Set<string>,
    _runningPids: Map<number, PidInfo>,
    opts?: ListOpts,
  ): Promise<void> {
    let files: string[];
    try {
      files = await fs.readdir(this.sessionsMetaDir);
    } catch {
      return;
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const sessionId = file.replace(/\.json$/, "");
      if (seenIds.has(sessionId)) continue;

      let meta: LaunchedSessionMeta | null;
      try {
        const raw = await fs.readFile(
          path.join(this.sessionsMetaDir, file),
          "utf-8",
        );
        meta = JSON.parse(raw) as LaunchedSessionMeta;
      } catch {
        continue;
      }
      if (!meta?.sessionId) continue;

      // Check if it has an exit file → stopped
      const exitFilePath = path.join(this.sessionsMetaDir, `${sessionId}.exit`);
      const exitCode = await this.readExitFile(exitFilePath);
      const pidAlive = meta.pid ? this.isProcessAlive(meta.pid) : false;
      const isRunning = exitCode === null && pidAlive;

      const launchedAt = meta.launchedAt
        ? new Date(meta.launchedAt)
        : new Date();

      const session: AgentSession = {
        id: meta.sessionId,
        adapter: this.id,
        status: isRunning ? "running" : "stopped",
        startedAt: launchedAt,
        stoppedAt: isRunning ? undefined : new Date(),
        pid: isRunning ? meta.pid : undefined,
        cwd: meta.cwd,
        model: meta.model,
        prompt: meta.prompt,
        group: meta.group,
        meta: { source: "meta-dir", exitCode: exitCode ?? undefined },
      };

      // Apply filters
      if (opts?.status && session.status !== opts.status) continue;
      if (!opts?.all && session.status === "stopped") {
        const age = Date.now() - session.startedAt.getTime();
        if (age > STOPPED_SESSION_MAX_AGE_MS) continue;
      }
      if (
        !opts?.all &&
        !opts?.status &&
        session.status !== "running" &&
        session.status !== "idle"
      ) {
        continue;
      }

      seenIds.add(sessionId);
      sessions.push(session);
    }
  }

  /**
   * Enumerate sessions from opencode's native storage directory.
   */
  private async listFromNativeStorage(
    sessions: AgentSession[],
    seenIds: Set<string>,
    runningPids: Map<number, PidInfo>,
    opts?: ListOpts,
  ): Promise<void> {
    let projectDirs: string[];
    try {
      projectDirs = await fs.readdir(this.sessionDir);
    } catch {
      return;
    }

    for (const projHash of projectDirs) {
      const projPath = path.join(this.sessionDir, projHash);
      const stat = await fs.stat(projPath).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const sessionFiles = await this.getSessionFilesForProject(projPath);

      for (const sessionData of sessionFiles) {
        if (seenIds.has(sessionData.id)) continue;

        const session = await this.buildSession(sessionData, runningPids);

        // Filter by status
        if (opts?.status && session.status !== opts.status) continue;

        // If not --all, skip old stopped sessions
        if (!opts?.all && session.status === "stopped") {
          const age = Date.now() - session.startedAt.getTime();
          if (age > STOPPED_SESSION_MAX_AGE_MS) continue;
        }

        // Default: only show running sessions unless --all
        if (
          !opts?.all &&
          !opts?.status &&
          session.status !== "running" &&
          session.status !== "idle"
        ) {
          continue;
        }

        seenIds.add(sessionData.id);
        sessions.push(session);
      }
    }
  }

  // --- Private helpers ---

  /**
   * Read all session JSON files for a project directory.
   */
  private async getSessionFilesForProject(
    projPath: string,
  ): Promise<OpenCodeSessionFile[]> {
    const results: OpenCodeSessionFile[] = [];

    let files: string[];
    try {
      files = await fs.readdir(projPath);
    } catch {
      return [];
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const fullPath = path.join(projPath, file);

      try {
        const content = await fs.readFile(fullPath, "utf-8");
        const sessionData = JSON.parse(content) as OpenCodeSessionFile;
        if (sessionData.id) {
          results.push(sessionData);
        }
      } catch {
        // Skip malformed files
      }
    }

    return results;
  }

  /**
   * Build an AgentSession from an OpenCode session file.
   */
  private async buildSession(
    sessionData: OpenCodeSessionFile,
    runningPids: Map<number, PidInfo>,
  ): Promise<AgentSession> {
    const isRunning = await this.isSessionRunning(sessionData, runningPids);

    // Read messages for token/model/cost info
    const { model, tokens, cost } = await this.aggregateMessageStats(
      sessionData.id,
    );

    const createdAt = sessionData.time?.created
      ? new Date(sessionData.time.created)
      : new Date();
    const updatedAt = sessionData.time?.updated
      ? new Date(sessionData.time.updated)
      : undefined;

    return {
      id: sessionData.id,
      adapter: this.id,
      status: isRunning ? "running" : "stopped",
      startedAt: createdAt,
      stoppedAt: isRunning ? undefined : updatedAt,
      cwd: sessionData.directory,
      model,
      prompt: sessionData.title?.slice(0, 200),
      tokens,
      cost,
      pid: isRunning
        ? await this.findMatchingPid(sessionData, runningPids)
        : undefined,
      meta: {
        projectID: sessionData.projectID,
        slug: sessionData.slug,
        summary: sessionData.summary,
        version: sessionData.version,
      },
    };
  }

  /**
   * Check whether a session is currently running by cross-referencing PIDs.
   */
  private async isSessionRunning(
    sessionData: OpenCodeSessionFile,
    runningPids: Map<number, PidInfo>,
  ): Promise<boolean> {
    const directory = sessionData.directory;
    if (!directory) return false;

    const sessionCreated = sessionData.time?.created
      ? new Date(sessionData.time.created).getTime()
      : 0;

    // 1. Check running PIDs discovered via `ps aux`
    for (const [, info] of runningPids) {
      if (info.cwd === directory) {
        if (this.processStartedAfterSession(info, sessionCreated)) return true;
      }
    }

    // 2. Check persisted session metadata (for detached processes)
    const meta = await readSessionMeta(this.sessionsMetaDir, sessionData.id);
    if (meta?.pid) {
      if (this.isProcessAlive(meta.pid)) {
        // Cross-check: if this PID appears in runningPids with a DIFFERENT
        // start time than what we recorded, the PID was recycled.
        const pidInfo = runningPids.get(meta.pid);
        if (pidInfo?.startTime && meta.startTime) {
          const currentStartMs = new Date(pidInfo.startTime).getTime();
          const recordedStartMs = new Date(meta.startTime).getTime();
          if (
            !Number.isNaN(currentStartMs) &&
            !Number.isNaN(recordedStartMs) &&
            Math.abs(currentStartMs - recordedStartMs) > 5000
          ) {
            await deleteSessionMeta(this.sessionsMetaDir, sessionData.id);
            return false;
          }
        }

        // Verify stored start time is consistent with launch time
        if (meta.startTime) {
          const metaStartMs = new Date(meta.startTime).getTime();
          const sessionMs = new Date(meta.launchedAt).getTime();
          if (!Number.isNaN(metaStartMs) && metaStartMs >= sessionMs - 5000) {
            return true;
          }
          await deleteSessionMeta(this.sessionsMetaDir, sessionData.id);
          return false;
        }
        return true;
      }
      await deleteSessionMeta(this.sessionsMetaDir, sessionData.id);
    }

    // 3. Fallback: check if session was updated very recently (last 60s)
    if (sessionData.time?.updated) {
      const updatedMs = new Date(sessionData.time.updated).getTime();
      const age = Date.now() - updatedMs;
      if (age < 60_000) {
        for (const [, info] of runningPids) {
          if (
            info.cwd === directory &&
            this.processStartedAfterSession(info, sessionCreated)
          ) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Lightweight aliveness check for single-session queries (status/peek).
   * Avoids the expensive getOpenCodePids() call (ps aux + lsof per process)
   * by using persisted metadata and recency heuristics.
   */
  private async isSessionRunningLightweight(
    sessionData: OpenCodeSessionFile,
  ): Promise<boolean> {
    // 1. Check persisted session metadata (for sessions launched via agentctl)
    const meta = await readSessionMeta(this.sessionsMetaDir, sessionData.id);
    if (meta?.pid && this.isProcessAlive(meta.pid)) {
      return true;
    }

    // 2. Heuristic: session updated very recently → likely still running
    if (sessionData.time?.updated) {
      const updatedMs = new Date(sessionData.time.updated).getTime();
      if (!Number.isNaN(updatedMs) && Date.now() - updatedMs < 60_000) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check whether a process plausibly belongs to a session by verifying
   * the process started at or after the session's creation time.
   */
  private processStartedAfterSession(
    info: PidInfo,
    sessionCreatedMs: number,
  ): boolean {
    if (!info.startTime) return false;
    const processStartMs = new Date(info.startTime).getTime();
    if (Number.isNaN(processStartMs)) return false;
    return processStartMs >= sessionCreatedMs - 5000;
  }

  private async findMatchingPid(
    sessionData: OpenCodeSessionFile,
    runningPids: Map<number, PidInfo>,
  ): Promise<number | undefined> {
    const directory = sessionData.directory;
    const sessionCreated = sessionData.time?.created
      ? new Date(sessionData.time.created).getTime()
      : 0;

    for (const [pid, info] of runningPids) {
      if (info.cwd === directory) {
        if (this.processStartedAfterSession(info, sessionCreated)) return pid;
      }
    }

    const meta = await readSessionMeta(this.sessionsMetaDir, sessionData.id);
    if (meta?.pid && this.isProcessAlive(meta.pid)) {
      return meta.pid;
    }

    return undefined;
  }

  /**
   * Read all messages for a session and aggregate stats.
   */
  private async aggregateMessageStats(sessionId: string): Promise<{
    model?: string;
    tokens?: { in: number; out: number };
    cost?: number;
  }> {
    const messages = await this.readMessages(sessionId);

    let model: string | undefined;
    let totalIn = 0;
    let totalOut = 0;
    let totalCost = 0;

    for (const msg of messages) {
      if (msg.role === "assistant") {
        if (msg.modelID) model = msg.modelID;
        else if (msg.model?.modelID) model = msg.model.modelID;
        if (msg.tokens) {
          totalIn += msg.tokens.input || 0;
          totalOut += msg.tokens.output || 0;
        }
        if (msg.cost) totalCost += msg.cost;
      }
    }

    return {
      model,
      tokens: totalIn || totalOut ? { in: totalIn, out: totalOut } : undefined,
      cost: totalCost > 0 ? totalCost : undefined,
    };
  }

  /**
   * Read all message files for a session, sorted by time.
   */
  private async readMessages(
    sessionId: string,
  ): Promise<OpenCodeMessageFile[]> {
    const msgDir = path.join(this.messageDir, sessionId);
    const messages: OpenCodeMessageFile[] = [];

    let files: string[];
    try {
      files = await fs.readdir(msgDir);
    } catch {
      return [];
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await fs.readFile(path.join(msgDir, file), "utf-8");
        const msg = JSON.parse(content) as OpenCodeMessageFile;
        if (msg.id) messages.push(msg);
      } catch {
        // Skip malformed files
      }
    }

    // Sort by creation time
    messages.sort((a, b) => {
      const aTime = a.time?.created ? new Date(a.time.created).getTime() : 0;
      const bTime = b.time?.created ? new Date(b.time.created).getTime() : 0;
      return aTime - bTime;
    });

    return messages;
  }

  /**
   * Read message content parts from storage/part/<messageId>/
   */
  private async readMessageParts(messageId: string): Promise<string> {
    const partDir = path.join(this.storageDir, "part", messageId);
    const parts: string[] = [];

    let files: string[];
    try {
      files = await fs.readdir(partDir);
    } catch {
      return "";
    }

    // Sort part files to maintain order
    files.sort();

    for (const file of files) {
      try {
        const content = await fs.readFile(path.join(partDir, file), "utf-8");
        try {
          const parsed = JSON.parse(content);
          if (typeof parsed.text === "string") {
            parts.push(parsed.text);
          } else if (typeof parsed.content === "string") {
            parts.push(parsed.content);
          } else if (typeof parsed === "string") {
            parts.push(parsed);
          }
        } catch {
          // Not JSON — treat as raw text
          if (content.trim()) parts.push(content.trim());
        }
      } catch {
        // Skip unreadable files
      }
    }

    return parts.join("\n");
  }

  /**
   * Resolve a session ID (supports prefix matching).
   */
  private async resolveSessionId(
    sessionId: string,
  ): Promise<OpenCodeSessionFile | null> {
    let projectDirs: string[];
    try {
      projectDirs = await fs.readdir(this.sessionDir);
    } catch {
      return null;
    }

    for (const projHash of projectDirs) {
      const projPath = path.join(this.sessionDir, projHash);
      const stat = await fs.stat(projPath).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const sessionFiles = await this.getSessionFilesForProject(projPath);
      const match = sessionFiles.find(
        (s) => s.id === sessionId || s.id.startsWith(sessionId),
      );
      if (match) return match;
    }

    return null;
  }

  private async findPidForSession(sessionId: string): Promise<number | null> {
    const session = await this.status(sessionId);
    return session.pid ?? null;
  }
}

// --- Utility functions ---

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getOpenCodePids(): Promise<Map<number, PidInfo>> {
  const pids = new Map<number, PidInfo>();

  try {
    const { stdout } = await execFileAsync("ps", ["aux"]);

    for (const line of stdout.split("\n")) {
      if (!line.includes("opencode") || line.includes("grep")) continue;

      const fields = line.trim().split(/\s+/);
      if (fields.length < 11) continue;
      const pid = parseInt(fields[1], 10);
      const command = fields.slice(10).join(" ");

      // Match opencode processes (run, serve, etc.)
      if (!command.includes("opencode")) continue;
      if (pid === process.pid) continue;

      // Try to extract working directory from lsof
      let cwd = "";
      try {
        const { stdout: lsofOut } = await execFileAsync("/usr/sbin/lsof", [
          "-p",
          pid.toString(),
          "-Fn",
        ]);
        const lsofLines = lsofOut.split("\n");
        for (let i = 0; i < lsofLines.length; i++) {
          if (lsofLines[i] === "fcwd" && lsofLines[i + 1]?.startsWith("n")) {
            cwd = lsofLines[i + 1].slice(1);
            break;
          }
        }
      } catch {
        // lsof might fail
      }

      // Get process start time for PID recycling detection
      let startTime: string | undefined;
      try {
        const { stdout: lstart } = await execFileAsync("ps", [
          "-p",
          pid.toString(),
          "-o",
          "lstart=",
        ]);
        startTime = lstart.trim() || undefined;
      } catch {
        // ps might fail
      }

      pids.set(pid, { pid, cwd, args: command, startTime });
    }
  } catch {
    // ps failed — return empty
  }

  return pids;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
