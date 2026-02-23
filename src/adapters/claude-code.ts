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
  LaunchOpts,
  LifecycleEvent,
  ListOpts,
  PeekOpts,
  StopOpts,
} from "../core/types.js";
import { readHead, readTail } from "../utils/partial-read.js";

const execFileAsync = promisify(execFile);

const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), ".claude");

// Default: only show stopped sessions from the last 7 days
const STOPPED_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PidInfo {
  pid: number;
  cwd: string;
  args: string;
  /** Process start time from `ps -p <pid> -o lstart=`, used to detect PID recycling */
  startTime?: string;
}

/** Metadata persisted by launch() so status checks survive wrapper exit */
export interface LaunchedSessionMeta {
  sessionId: string;
  pid: number;
  /** Process start time from `ps -p <pid> -o lstart=` for PID recycling detection */
  startTime?: string;
  /** The PID of the wrapper (agentctl launch) — may differ from `pid` (Claude Code process) */
  wrapperPid?: number;
  cwd: string;
  model?: string;
  prompt?: string;
  launchedAt: string;
}

export interface ClaudeCodeAdapterOpts {
  claudeDir?: string; // Override ~/.claude for testing
  sessionsMetaDir?: string; // Override metadata dir for testing
  getPids?: () => Promise<Map<number, PidInfo>>; // Override PID detection for testing
  /** Override PID liveness check for testing (default: process.kill(pid, 0)) */
  isProcessAlive?: (pid: number) => boolean;
}

interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt?: string;
  messageCount?: number;
  created: string;
  modified: string;
  gitBranch?: string;
  projectPath?: string;
  isSidechain?: boolean;
}

interface SessionIndex {
  version: number;
  entries: SessionIndexEntry[];
  originalPath?: string;
}

interface JSONLMessage {
  type: "user" | "assistant" | "queue-operation" | string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  permissionMode?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
}

/**
 * Claude Code adapter — reads session data directly from ~/.claude/
 * and cross-references with running PIDs. NEVER maintains its own registry.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code";
  private readonly claudeDir: string;
  private readonly projectsDir: string;
  private readonly sessionsMetaDir: string;
  private readonly getPids: () => Promise<Map<number, PidInfo>>;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(opts?: ClaudeCodeAdapterOpts) {
    this.claudeDir = opts?.claudeDir || DEFAULT_CLAUDE_DIR;
    this.projectsDir = path.join(this.claudeDir, "projects");
    this.sessionsMetaDir =
      opts?.sessionsMetaDir ||
      path.join(this.claudeDir, "agentctl", "sessions");
    this.getPids = opts?.getPids || getClaudePids;
    this.isProcessAlive = opts?.isProcessAlive || defaultIsProcessAlive;
  }

  async list(opts?: ListOpts): Promise<AgentSession[]> {
    const runningPids = await this.getPids();
    const sessions: AgentSession[] = [];

    let projectDirs: string[];
    try {
      projectDirs = await fs.readdir(this.projectsDir);
    } catch {
      return [];
    }

    for (const projDir of projectDirs) {
      const projPath = path.join(this.projectsDir, projDir);
      const stat = await fs.stat(projPath).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const entries = await this.getEntriesForProject(projPath, projDir);

      for (const { entry, index } of entries) {
        if (entry.isSidechain) continue;

        const session = await this.buildSessionFromIndex(
          entry,
          index,
          runningPids,
        );

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

        sessions.push(session);
      }
    }

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
    const jsonlPath = await this.findSessionFile(sessionId);
    if (!jsonlPath) throw new Error(`Session not found: ${sessionId}`);

    const content = await fs.readFile(jsonlPath, "utf-8");
    const jsonlLines = content.trim().split("\n");

    const assistantMessages: string[] = [];
    for (const line of jsonlLines) {
      try {
        const msg = JSON.parse(line) as JSONLMessage;
        if (msg.type === "assistant" && msg.message?.content) {
          const text = extractTextContent(msg.message.content);
          if (text) assistantMessages.push(text);
        }
      } catch {
        // skip malformed lines
      }
    }

    // Take last N messages
    const recent = assistantMessages.slice(-lines);
    return recent.join("\n---\n");
  }

  async status(sessionId: string): Promise<AgentSession> {
    const runningPids = await this.getPids();
    const entry = await this.findIndexEntry(sessionId);
    if (!entry) throw new Error(`Session not found: ${sessionId}`);

    return this.buildSessionFromIndex(entry.entry, entry.index, runningPids);
  }

  async launch(opts: LaunchOpts): Promise<AgentSession> {
    const args = [
      "--dangerously-skip-permissions",
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
    ];

    if (opts.model) {
      args.push("--model", opts.model);
    }

    args.push("-p", opts.prompt);

    const env = { ...process.env, ...opts.env };
    const cwd = opts.cwd || process.cwd();

    // Write stdout to a log file so we can extract the session ID
    // without keeping a pipe open (which would prevent full detachment).
    await fs.mkdir(this.sessionsMetaDir, { recursive: true });
    const logPath = path.join(this.sessionsMetaDir, `launch-${Date.now()}.log`);
    const logFd = await fs.open(logPath, "w");

    // Capture stderr to the same log file for debugging launch failures
    const child = spawn("claude", args, {
      cwd,
      env,
      stdio: ["ignore", logFd.fd, logFd.fd],
      detached: true,
    });

    // Fully detach: child runs in its own process group.
    // When the wrapper gets SIGTERM, the child keeps running.
    child.unref();

    const pid = child.pid;
    const now = new Date();

    // Close our handle — child keeps its own fd open
    await logFd.close();

    // Try to extract the real Claude Code session ID from the log output.
    // Claude Code's stream-json format emits a line with sessionId early on.
    let resolvedSessionId: string | undefined;
    if (pid) {
      resolvedSessionId = await this.pollForSessionId(logPath, pid, 5000);
    }

    const sessionId =
      resolvedSessionId || (pid ? `pending-${pid}` : crypto.randomUUID());

    // Persist session metadata so status checks work after wrapper exits
    if (pid) {
      await this.writeSessionMeta({
        sessionId,
        pid,
        wrapperPid: process.pid,
        cwd,
        model: opts.model,
        prompt: opts.prompt.slice(0, 200),
        launchedAt: now.toISOString(),
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
        logPath,
      },
    };

    return session;
  }

  /**
   * Poll the launch log file for up to `timeoutMs` to extract the real session ID.
   * Claude Code's stream-json output includes sessionId in early messages.
   */
  private async pollForSessionId(
    logPath: string,
    pid: number,
    timeoutMs: number,
  ): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const content = await fs.readFile(logPath, "utf-8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.sessionId && typeof msg.sessionId === "string") {
              return msg.sessionId;
            }
          } catch {
            // Not valid JSON yet
          }
        }
      } catch {
        // File may not exist yet
      }
      // Check if process is still alive
      try {
        process.kill(pid, 0);
      } catch {
        break; // Process died
      }
      await sleep(200);
    }
    return undefined;
  }

  async stop(sessionId: string, opts?: StopOpts): Promise<void> {
    const pid = await this.findPidForSession(sessionId);
    if (!pid) throw new Error(`No running process for session: ${sessionId}`);

    if (opts?.force) {
      // SIGINT first, then SIGKILL after 5s
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
    const args = [
      "--dangerously-skip-permissions",
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--continue",
      sessionId,
      "-p",
      message,
    ];

    const session = await this.status(sessionId).catch(() => null);
    const cwd = session?.cwd || process.cwd();

    const child = spawn("claude", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    child.unref();
  }

  async *events(): AsyncIterable<LifecycleEvent> {
    // Track known sessions to detect transitions
    let knownSessions = new Map<string, AgentSession>();

    // Initial snapshot
    const initial = await this.list({ all: true });
    for (const s of initial) {
      knownSessions.set(s.id, s);
    }

    // Poll + fs.watch hybrid
    const watcher = watch(this.projectsDir, { recursive: true });

    try {
      while (true) {
        await sleep(5000);

        const current = await this.list({ all: true });
        const currentMap = new Map(current.map((s) => [s.id, s]));

        // Detect new sessions
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
      watcher.close();
    }
  }

  // --- Private helpers ---

  /**
   * Get session entries for a project — uses sessions-index.json when available,
   * falls back to scanning .jsonl files for projects without an index
   * (e.g. currently running sessions that haven't been indexed yet).
   */
  private async getEntriesForProject(
    projPath: string,
    _projDirName: string,
  ): Promise<Array<{ entry: SessionIndexEntry; index: SessionIndex }>> {
    // Try index first
    const indexPath = path.join(projPath, "sessions-index.json");
    try {
      const raw = await fs.readFile(indexPath, "utf-8");
      const index = JSON.parse(raw) as SessionIndex;
      return index.entries.map((entry) => ({ entry, index }));
    } catch {
      // No index — fall back to scanning .jsonl files
    }

    // We'll determine originalPath from the JSONL content below
    let originalPath: string | undefined;

    const results: Array<{ entry: SessionIndexEntry; index: SessionIndex }> =
      [];

    let files: string[];
    try {
      files = await fs.readdir(projPath);
    } catch {
      return [];
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.replace(".jsonl", "");
      const fullPath = path.join(projPath, file);

      let fileStat: Awaited<ReturnType<typeof fs.stat>> | undefined;
      try {
        fileStat = await fs.stat(fullPath);
      } catch {
        continue;
      }

      // Read first few lines for prompt and cwd (only first 8KB, not entire file)
      let firstPrompt = "";
      let sessionCwd = "";
      try {
        const headLines = await readHead(fullPath, 20, 8192);
        for (const l of headLines) {
          try {
            const msg = JSON.parse(l);
            if (msg.cwd && !sessionCwd) sessionCwd = msg.cwd;
            if (msg.type === "user" && msg.message?.content && !firstPrompt) {
              const c = msg.message.content;
              firstPrompt = typeof c === "string" ? c : "";
            }
            if (sessionCwd && firstPrompt) break;
          } catch {
            // skip
          }
        }
      } catch {
        // skip
      }

      if (!originalPath && sessionCwd) {
        originalPath = sessionCwd;
      }

      const entryPath = sessionCwd || originalPath;

      const index: SessionIndex = {
        version: 1,
        entries: [],
        originalPath: entryPath,
      };

      const entry: SessionIndexEntry = {
        sessionId,
        fullPath,
        fileMtime: fileStat.mtimeMs,
        firstPrompt,
        created: fileStat.birthtime.toISOString(),
        modified: fileStat.mtime.toISOString(),
        projectPath: entryPath,
        isSidechain: false,
      };

      results.push({ entry, index });
    }

    return results;
  }

  private async buildSessionFromIndex(
    entry: SessionIndexEntry,
    index: SessionIndex,
    runningPids: Map<number, PidInfo>,
  ): Promise<AgentSession> {
    const isRunning = await this.isSessionRunning(entry, index, runningPids);

    // Parse JSONL for token/model info (read last few lines for efficiency)
    const { model, tokens } = await this.parseSessionTail(entry.fullPath);

    return {
      id: entry.sessionId,
      adapter: this.id,
      status: isRunning ? "running" : "stopped",
      startedAt: new Date(entry.created),
      stoppedAt: isRunning ? undefined : new Date(entry.modified),
      cwd: index.originalPath || entry.projectPath,
      model,
      prompt: entry.firstPrompt?.slice(0, 200),
      tokens,
      pid: isRunning
        ? await this.findMatchingPid(entry, index, runningPids)
        : undefined,
      meta: {
        projectDir: index.originalPath || entry.projectPath,
        gitBranch: entry.gitBranch,
        messageCount: entry.messageCount,
      },
    };
  }

  private async isSessionRunning(
    entry: SessionIndexEntry,
    index: SessionIndex,
    runningPids: Map<number, PidInfo>,
  ): Promise<boolean> {
    const projectPath = index.originalPath || entry.projectPath;
    if (!projectPath) return false;

    const sessionCreated = new Date(entry.created).getTime();

    // 1. Check running PIDs discovered via `ps aux`
    for (const [, info] of runningPids) {
      // Check if the session ID appears in the command args — most reliable match
      if (info.args.includes(entry.sessionId)) {
        if (this.processStartedAfterSession(info, sessionCreated)) return true;
        // PID recycling: process started before this session existed
        continue;
      }
      // Match by cwd — less specific (multiple sessions share a project)
      if (info.cwd === projectPath) {
        if (this.processStartedAfterSession(info, sessionCreated)) return true;
      }
    }

    // 2. Check persisted session metadata (for detached processes that
    //    may not appear in `ps aux` filtering, e.g. after wrapper exit)
    const meta = await this.readSessionMeta(entry.sessionId);
    if (meta?.pid) {
      // Verify the persisted PID is still alive
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
            // Process at this PID has a different start time — recycled
            await this.deleteSessionMeta(entry.sessionId);
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
          // Start time doesn't match — PID was recycled, clean up stale metadata
          await this.deleteSessionMeta(entry.sessionId);
          return false;
        }
        // No start time in metadata — can't verify, assume alive
        // (only for sessions launched with the new detached model)
        return true;
      }
      // PID is dead — clean up stale metadata
      await this.deleteSessionMeta(entry.sessionId);
    }

    // 3. Fallback: check if JSONL was modified very recently (last 60s)
    try {
      const stat = await fs.stat(entry.fullPath);
      const age = Date.now() - stat.mtimeMs;
      if (age < 60_000) {
        // Double-check: is there any claude process running with matching cwd
        // that started after this session?
        for (const [, info] of runningPids) {
          if (
            info.cwd === projectPath &&
            this.processStartedAfterSession(info, sessionCreated)
          ) {
            return true;
          }
        }
      }
    } catch {
      // file doesn't exist
    }

    return false;
  }

  /**
   * Check whether a process plausibly belongs to a session by verifying
   * the process started at or after the session's creation time.
   * This detects PID recycling: if a process started before the session
   * was created, it can't be the process that's running this session.
   *
   * When start time is unavailable, defaults to false (assume no match).
   * This prevents old sessions from appearing as 'running' due to
   * recycled PIDs when start time verification is impossible.
   */
  private processStartedAfterSession(
    info: PidInfo,
    sessionCreatedMs: number,
  ): boolean {
    if (!info.startTime) return false; // Can't verify — assume no match (safety)
    const processStartMs = new Date(info.startTime).getTime();
    if (Number.isNaN(processStartMs)) return false; // Unparseable — assume no match
    // Allow 5s tolerance for clock skew between session creation time and ps output
    return processStartMs >= sessionCreatedMs - 5000;
  }

  private async findMatchingPid(
    entry: SessionIndexEntry,
    index: SessionIndex,
    runningPids: Map<number, PidInfo>,
  ): Promise<number | undefined> {
    const projectPath = index.originalPath || entry.projectPath;
    const sessionCreated = new Date(entry.created).getTime();

    for (const [pid, info] of runningPids) {
      if (info.args.includes(entry.sessionId)) {
        if (this.processStartedAfterSession(info, sessionCreated)) return pid;
        continue;
      }
      if (info.cwd === projectPath) {
        if (this.processStartedAfterSession(info, sessionCreated)) return pid;
      }
    }

    // Check persisted metadata for detached processes
    const meta = await this.readSessionMeta(entry.sessionId);
    if (meta?.pid && this.isProcessAlive(meta.pid)) {
      return meta.pid;
    }

    return undefined;
  }

  private async parseSessionTail(
    jsonlPath: string,
  ): Promise<{ model?: string; tokens?: { in: number; out: number } }> {
    try {
      let model: string | undefined;
      let totalIn = 0;
      let totalOut = 0;

      // Read only the last 64KB for the tail (not entire file)
      const tail = await readTail(jsonlPath, 100, 65536);
      for (const line of tail) {
        try {
          const msg = JSON.parse(line) as JSONLMessage;
          if (msg.type === "assistant" && msg.message) {
            if (msg.message.model) model = msg.message.model;
            if (msg.message.usage) {
              totalIn += msg.message.usage.input_tokens || 0;
              totalOut += msg.message.usage.output_tokens || 0;
            }
          }
        } catch {
          // skip
        }
      }

      // Also scan first few lines for model if we didn't find it
      if (!model) {
        const head = await readHead(jsonlPath, 20, 8192);
        for (const line of head) {
          try {
            const msg = JSON.parse(line) as JSONLMessage;
            if (msg.type === "assistant" && msg.message?.model) {
              model = msg.message.model;
              break;
            }
          } catch {
            // skip
          }
        }
      }

      return {
        model,
        tokens:
          totalIn || totalOut ? { in: totalIn, out: totalOut } : undefined,
      };
    } catch {
      return {};
    }
  }

  private async findSessionFile(sessionId: string): Promise<string | null> {
    const entry = await this.findIndexEntry(sessionId);
    if (!entry) return null;
    try {
      await fs.access(entry.entry.fullPath);
      return entry.entry.fullPath;
    } catch {
      return null;
    }
  }

  private async findIndexEntry(
    sessionId: string,
  ): Promise<{ entry: SessionIndexEntry; index: SessionIndex } | null> {
    let projectDirs: string[];
    try {
      projectDirs = await fs.readdir(this.projectsDir);
    } catch {
      return null;
    }

    for (const projDir of projectDirs) {
      const projPath = path.join(this.projectsDir, projDir);
      const stat = await fs.stat(projPath).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const entries = await this.getEntriesForProject(projPath, projDir);
      // Support prefix matching for short IDs
      const match = entries.find(
        ({ entry: e }) =>
          e.sessionId === sessionId || e.sessionId.startsWith(sessionId),
      );
      if (match) return match;
    }

    return null;
  }

  private async findPidForSession(sessionId: string): Promise<number | null> {
    const session = await this.status(sessionId);
    return session.pid ?? null;
  }

  // --- Session metadata persistence ---

  /** Write session metadata to disk so status checks survive wrapper exit */
  async writeSessionMeta(
    meta: Omit<LaunchedSessionMeta, "startTime">,
  ): Promise<void> {
    await fs.mkdir(this.sessionsMetaDir, { recursive: true });

    // Try to capture the process start time immediately
    let startTime: string | undefined;
    try {
      const { stdout } = await execFileAsync("ps", [
        "-p",
        meta.pid.toString(),
        "-o",
        "lstart=",
      ]);
      startTime = stdout.trim() || undefined;
    } catch {
      // Process may have already exited or ps failed
    }

    const fullMeta: LaunchedSessionMeta = { ...meta, startTime };
    const metaPath = path.join(this.sessionsMetaDir, `${meta.sessionId}.json`);
    await fs.writeFile(metaPath, JSON.stringify(fullMeta, null, 2));
  }

  /** Read persisted session metadata */
  async readSessionMeta(
    sessionId: string,
  ): Promise<LaunchedSessionMeta | null> {
    // Check exact sessionId first
    const metaPath = path.join(this.sessionsMetaDir, `${sessionId}.json`);
    try {
      const raw = await fs.readFile(metaPath, "utf-8");
      return JSON.parse(raw) as LaunchedSessionMeta;
    } catch {
      // File doesn't exist or is unreadable
    }

    // Scan all metadata files for one whose sessionId matches
    // (handles resolved session IDs that were originally pending-*)
    try {
      const files = await fs.readdir(this.sessionsMetaDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = await fs.readFile(
            path.join(this.sessionsMetaDir, file),
            "utf-8",
          );
          const meta = JSON.parse(raw) as LaunchedSessionMeta;
          if (meta.sessionId === sessionId) return meta;
        } catch {
          // skip
        }
      }
    } catch {
      // Dir doesn't exist
    }
    return null;
  }

  /** Delete stale session metadata */
  private async deleteSessionMeta(sessionId: string): Promise<void> {
    for (const id of [sessionId, `pending-${sessionId}`]) {
      const metaPath = path.join(this.sessionsMetaDir, `${id}.json`);
      try {
        await fs.unlink(metaPath);
      } catch {
        // File doesn't exist
      }
    }
  }
}

// --- Utility functions ---

/** Check if a process is alive via kill(pid, 0) signal check */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getClaudePids(): Promise<Map<number, PidInfo>> {
  const pids = new Map<number, PidInfo>();

  try {
    const { stdout } = await execFileAsync("ps", ["aux"]);

    for (const line of stdout.split("\n")) {
      if (!line.includes("claude") || line.includes("grep")) continue;

      // Extract PID (second field) and command (everything after 10th field)
      const fields = line.trim().split(/\s+/);
      if (fields.length < 11) continue;
      const pid = parseInt(fields[1], 10);
      const command = fields.slice(10).join(" ");

      // Only match lines where the command starts with "claude --"
      // This excludes wrappers (tclsh, bash, screen, login) and
      // interactive claude sessions (just "claude" with no flags)
      if (!command.startsWith("claude --")) continue;
      if (pid === process.pid) continue;

      // Try to extract working directory from lsof
      let cwd = "";
      try {
        const { stdout: lsofOut } = await execFileAsync("/usr/sbin/lsof", [
          "-p",
          pid.toString(),
          "-Fn",
        ]);
        // lsof output: "fcwd\nn/actual/path\n..." — find fcwd line, then next n line
        const lsofLines = lsofOut.split("\n");
        for (let i = 0; i < lsofLines.length; i++) {
          if (lsofLines[i] === "fcwd" && lsofLines[i + 1]?.startsWith("n")) {
            cwd = lsofLines[i + 1].slice(1); // strip leading "n"
            break;
          }
        }
      } catch {
        // lsof might fail — that's fine
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
        // ps might fail — that's fine
      }

      pids.set(pid, { pid, cwd, args: command, startTime });
    }
  } catch {
    // ps failed — return empty
  }

  return pids;
}

function extractTextContent(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text as string)
      .join("\n");
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
