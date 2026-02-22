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
  /** The PID of the wrapper (agentctl launch) — may differ from `pid` (opencode process) */
  wrapperPid?: number;
  cwd: string;
  model?: string;
  prompt?: string;
  launchedAt: string;
}

/** Shape of an OpenCode session JSON file */
export interface OpenCodeSessionFile {
  id: string;
  slug?: string;
  version?: string;
  projectID?: string;
  directory?: string;
  title?: string;
  time?: {
    created?: string;
    updated?: string;
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
    created?: string;
    completed?: string;
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
}

export interface OpenCodeAdapterOpts {
  storageDir?: string; // Override ~/.local/share/opencode/storage for testing
  sessionsMetaDir?: string; // Override metadata dir for testing
  getPids?: () => Promise<Map<number, PidInfo>>; // Override PID detection for testing
  /** Override PID liveness check for testing (default: process.kill(pid, 0)) */
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Compute the project hash matching OpenCode's approach: SHA1 of the directory path.
 */
export function computeProjectHash(directory: string): string {
  return crypto.createHash("sha1").update(directory).digest("hex");
}

/**
 * OpenCode adapter — reads session data from ~/.local/share/opencode/storage/
 * and cross-references with running opencode processes.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly id = "opencode";
  private readonly storageDir: string;
  private readonly sessionDir: string;
  private readonly messageDir: string;
  private readonly sessionsMetaDir: string;
  private readonly getPids: () => Promise<Map<number, PidInfo>>;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(opts?: OpenCodeAdapterOpts) {
    this.storageDir = opts?.storageDir || DEFAULT_STORAGE_DIR;
    this.sessionDir = path.join(this.storageDir, "session");
    this.messageDir = path.join(this.storageDir, "message");
    this.sessionsMetaDir =
      opts?.sessionsMetaDir ||
      path.join(os.homedir(), ".agentctl", "opencode-sessions");
    this.getPids = opts?.getPids || getOpenCodePids;
    this.isProcessAlive = opts?.isProcessAlive || defaultIsProcessAlive;
  }

  async list(opts?: ListOpts): Promise<AgentSession[]> {
    const runningPids = await this.getPids();
    const sessions: AgentSession[] = [];

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
    const resolved = await this.resolveSessionId(sessionId);
    if (!resolved) throw new Error(`Session not found: ${sessionId}`);

    const messages = await this.readMessages(resolved.id);

    const assistantMessages: string[] = [];
    for (const msg of messages) {
      if (msg.role === "assistant") {
        // Read message content parts
        const text = await this.readMessageParts(msg.id);
        if (text) assistantMessages.push(text);
      }
    }

    // Take last N messages
    const recent = assistantMessages.slice(-lines);
    return recent.join("\n---\n");
  }

  async status(sessionId: string): Promise<AgentSession> {
    const runningPids = await this.getPids();
    const resolved = await this.resolveSessionId(sessionId);
    if (!resolved) throw new Error(`Session not found: ${sessionId}`);

    return this.buildSession(resolved, runningPids);
  }

  async launch(opts: LaunchOpts): Promise<AgentSession> {
    const args = ["run", opts.prompt];

    const env = { ...process.env, ...opts.env };
    const cwd = opts.cwd || process.cwd();

    await fs.mkdir(this.sessionsMetaDir, { recursive: true });

    const child = spawn("opencode", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    child.unref();

    const pid = child.pid;
    const now = new Date();

    // Generate a pending session ID — will be resolved when OpenCode creates the session file
    const sessionId = pid ? `pending-${pid}` : crypto.randomUUID();

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
      },
    };

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

    const child = spawn("opencode", ["run", message], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    child.unref();
  }

  async *events(): AsyncIterable<LifecycleEvent> {
    let knownSessions = new Map<string, AgentSession>();

    const initial = await this.list({ all: true });
    for (const s of initial) {
      knownSessions.set(s.id, s);
    }

    // Poll + fs.watch hybrid
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      watcher = watch(this.sessionDir, { recursive: true });
    } catch {
      // Directory may not exist
    }

    try {
      while (true) {
        await sleep(5000);

        const current = await this.list({ all: true });
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
    const meta = await this.readSessionMeta(sessionData.id);
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
            await this.deleteSessionMeta(sessionData.id);
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
          await this.deleteSessionMeta(sessionData.id);
          return false;
        }
        return true;
      }
      await this.deleteSessionMeta(sessionData.id);
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

    const meta = await this.readSessionMeta(sessionData.id);
    if (meta?.pid && this.isProcessAlive(meta.pid)) {
      return meta.pid;
    }

    return undefined;
  }

  /**
   * Read all messages for a session and aggregate stats.
   */
  private async aggregateMessageStats(
    sessionId: string,
  ): Promise<{ model?: string; tokens?: { in: number; out: number }; cost?: number }> {
    const messages = await this.readMessages(sessionId);

    let model: string | undefined;
    let totalIn = 0;
    let totalOut = 0;
    let totalCost = 0;

    for (const msg of messages) {
      if (msg.role === "assistant") {
        if (msg.model?.modelID) model = msg.model.modelID;
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

  // --- Session metadata persistence ---

  async writeSessionMeta(
    meta: Omit<LaunchedSessionMeta, "startTime">,
  ): Promise<void> {
    await fs.mkdir(this.sessionsMetaDir, { recursive: true });

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

  async readSessionMeta(
    sessionId: string,
  ): Promise<LaunchedSessionMeta | null> {
    const metaPath = path.join(this.sessionsMetaDir, `${sessionId}.json`);
    try {
      const raw = await fs.readFile(metaPath, "utf-8");
      return JSON.parse(raw) as LaunchedSessionMeta;
    } catch {
      // File doesn't exist or is unreadable
    }

    // Scan all metadata files for one whose sessionId matches
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
