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
import { resolveBinaryPath } from "../utils/resolve-binary.js";

const execFileAsync = promisify(execFile);

const DEFAULT_SESSION_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

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
  /** The PID of the wrapper (agentctl launch) — may differ from `pid` (pi-rust process) */
  wrapperPid?: number;
  cwd: string;
  model?: string;
  prompt?: string;
  launchedAt: string;
}

export interface PiRustAdapterOpts {
  sessionDir?: string; // Override ~/.pi/agent/sessions for testing
  sessionsMetaDir?: string; // Override metadata dir for testing
  getPids?: () => Promise<Map<number, PidInfo>>; // Override PID detection for testing
  /** Override PID liveness check for testing (default: process.kill(pid, 0)) */
  isProcessAlive?: (pid: number) => boolean;
}

/** Pi Rust JSONL session header (first line, type: "session") */
interface PiRustSessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

/** Pi Rust JSONL message entry */
interface PiRustMessage {
  type:
    | "message"
    | "session"
    | "model_change"
    | "thinking_level_change"
    | string;
  id: string;
  parentId?: string;
  timestamp: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
    model?: string;
    provider?: string;
    api?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      cost?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      };
    };
    stopReason?: string;
    timestamp?: number;
  };
  // Session header fields
  cwd?: string;
  provider?: string;
  modelId?: string;
  version?: number;
}

/**
 * Pi Rust adapter — reads session data directly from ~/.pi/agent/sessions/
 * and cross-references with running PIDs. NEVER maintains its own registry.
 *
 * Pi Rust (pi-rust / pi_agent_rust) stores sessions as JSONL files organized
 * by project directory. It also maintains a SQLite index for fast lookups,
 * but we read JSONL directly for simplicity and testability.
 */
export class PiRustAdapter implements AgentAdapter {
  readonly id = "pi-rust";
  private readonly sessionDir: string;
  private readonly sessionsMetaDir: string;
  private readonly getPids: () => Promise<Map<number, PidInfo>>;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(opts?: PiRustAdapterOpts) {
    this.sessionDir = opts?.sessionDir || DEFAULT_SESSION_DIR;
    this.sessionsMetaDir =
      opts?.sessionsMetaDir ||
      path.join(os.homedir(), ".pi", "agentctl", "sessions");
    this.getPids = opts?.getPids || getPiRustPids;
    this.isProcessAlive = opts?.isProcessAlive || defaultIsProcessAlive;
  }

  async discover(): Promise<DiscoveredSession[]> {
    const runningPids = await this.getPids();
    const results: DiscoveredSession[] = [];

    let projectDirs: string[];
    try {
      const entries = await fs.readdir(this.sessionDir);
      projectDirs = entries.filter((e) => e.startsWith("--"));
    } catch {
      return [];
    }

    for (const projDir of projectDirs) {
      const projPath = path.join(this.sessionDir, projDir);
      const stat = await fs.stat(projPath).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const projectCwd = decodeProjDir(projDir);
      const sessionFiles = await this.getSessionFiles(projPath);

      for (const file of sessionFiles) {
        const filePath = path.join(projPath, file);
        const header = await this.readSessionHeader(filePath);
        if (!header) continue;

        const isRunning = await this.isSessionRunning(
          header,
          projectCwd,
          runningPids,
        );
        const { model, tokens, cost } = await this.parseSessionTail(filePath);
        const firstPrompt = await this.readFirstPrompt(filePath);

        let fileStat: Awaited<ReturnType<typeof fs.stat>> | undefined;
        try {
          fileStat = await fs.stat(filePath);
        } catch {
          // ignore
        }

        results.push({
          id: header.id,
          status: isRunning ? "running" : "stopped",
          adapter: this.id,
          cwd: header.cwd || projectCwd,
          model: model || header.modelId,
          startedAt: new Date(header.timestamp),
          stoppedAt: isRunning
            ? undefined
            : fileStat
              ? new Date(Number(fileStat.mtimeMs))
              : undefined,
          pid: isRunning
            ? await this.findMatchingPid(header, projectCwd, runningPids)
            : undefined,
          prompt: firstPrompt?.slice(0, 200),
          tokens,
          cost: cost ?? undefined,
          nativeMetadata: {
            provider: header.provider,
            thinkingLevel: header.thinkingLevel,
            projectDir: projectCwd,
            sessionFile: filePath,
          },
        });
      }
    }

    return results;
  }

  async isAlive(sessionId: string): Promise<boolean> {
    const runningPids = await this.getPids();
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) return false;

    const header = await this.readSessionHeader(filePath);
    if (!header) return false;

    const projDir = path.basename(path.dirname(filePath));
    const projectCwd = decodeProjDir(projDir);

    return this.isSessionRunning(header, projectCwd, runningPids);
  }

  async list(opts?: ListOpts): Promise<AgentSession[]> {
    const runningPids = await this.getPids();
    const sessions: AgentSession[] = [];

    let projectDirs: string[];
    try {
      const entries = await fs.readdir(this.sessionDir);
      // Project dirs start with "--" (encoded paths)
      projectDirs = entries.filter((e) => e.startsWith("--"));
    } catch {
      return [];
    }

    for (const projDir of projectDirs) {
      const projPath = path.join(this.sessionDir, projDir);
      const stat = await fs.stat(projPath).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const projectCwd = decodeProjDir(projDir);
      const sessionFiles = await this.getSessionFiles(projPath);

      for (const file of sessionFiles) {
        const filePath = path.join(projPath, file);
        const header = await this.readSessionHeader(filePath);
        if (!header) continue;

        const session = await this.buildSession(
          header,
          filePath,
          projectCwd,
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
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) throw new Error(`Session not found: ${sessionId}`);

    const content = await fs.readFile(filePath, "utf-8");
    const jsonlLines = content.trim().split("\n");

    const assistantMessages: string[] = [];
    for (const line of jsonlLines) {
      try {
        const msg = JSON.parse(line) as PiRustMessage;
        if (
          msg.type === "message" &&
          msg.message?.role === "assistant" &&
          msg.message?.content
        ) {
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
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) throw new Error(`Session not found: ${sessionId}`);

    const header = await this.readSessionHeader(filePath);
    if (!header) throw new Error(`Session not found: ${sessionId}`);

    const projDir = path.basename(path.dirname(filePath));
    const projectCwd = decodeProjDir(projDir);

    return this.buildSession(header, filePath, projectCwd, runningPids);
  }

  async launch(opts: LaunchOpts): Promise<AgentSession> {
    const args = ["--print", "--mode", "json", opts.prompt];

    if (opts.model) {
      const { provider, model } = parseProviderModel(
        opts.model,
        opts.adapterOpts?.provider as string | undefined,
      );
      args.unshift("--model", model);
      if (provider) {
        args.unshift("--provider", provider);
      }
    } else if (opts.adapterOpts?.provider) {
      args.unshift("--provider", opts.adapterOpts.provider as string);
    }

    if (
      opts.appendSystemPrompt ||
      opts.adapterOpts?.appendSystemPrompt
    ) {
      const text = (opts.appendSystemPrompt ||
        opts.adapterOpts?.appendSystemPrompt) as string;
      args.unshift("--append-system-prompt", text);
    }

    const env = buildSpawnEnv(undefined, opts.env);
    const cwd = opts.cwd || process.cwd();

    // Write stdout to a log file so we can extract the session ID
    await fs.mkdir(this.sessionsMetaDir, { recursive: true });
    const logPath = path.join(this.sessionsMetaDir, `launch-${Date.now()}.log`);
    const logFd = await fs.open(logPath, "w");

    const piRustPath = await resolveBinaryPath("pi-rust");
    const child = spawn(piRustPath, args, {
      cwd,
      env,
      stdio: ["ignore", logFd.fd, "ignore"],
      detached: true,
    });

    child.on("error", (err) => {
      console.error(`[pi-rust] spawn error: ${err.message}`);
    });

    child.unref();

    const pid = child.pid;
    const now = new Date();

    await logFd.close();

    // Try to extract the real session ID from the JSONL output
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
   * Pi Rust's JSONL output includes the session ID in the first line (type: "session").
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
            if (
              msg.type === "session" &&
              msg.id &&
              typeof msg.id === "string"
            ) {
              return msg.id;
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
      process.kill(pid, "SIGINT");
      await sleep(5000);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead
      }
    } else {
      process.kill(pid, "SIGTERM");
    }
  }

  async resume(sessionId: string, message: string): Promise<void> {
    const filePath = await this.findSessionFile(sessionId);
    const session = filePath
      ? await this.status(sessionId).catch(() => null)
      : null;
    const cwd = session?.cwd || process.cwd();

    // pi-rust --continue resumes the previous session, --session <path> for a specific one
    const args = ["--print", "-p", message];
    if (filePath) {
      args.unshift("--session", filePath);
    } else {
      args.unshift("--continue");
    }

    const piRustPath = await resolveBinaryPath("pi-rust");
    const child = spawn(piRustPath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    child.on("error", (err) => {
      console.error(`[pi-rust] resume spawn error: ${err.message}`);
    });

    child.unref();
  }

  async *events(): AsyncIterable<LifecycleEvent> {
    let knownSessions = new Map<string, AgentSession>();

    const initial = await this.list({ all: true });
    for (const s of initial) {
      knownSessions.set(s.id, s);
    }

    const watcher = watch(this.sessionDir, { recursive: true });

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
      watcher.close();
    }
  }

  // --- Private helpers ---

  /** List .jsonl session files in a project directory */
  private async getSessionFiles(projPath: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(projPath);
      return entries.filter((e) => e.endsWith(".jsonl"));
    } catch {
      return [];
    }
  }

  /** Read and parse the session header (first line) from a JSONL file */
  private async readSessionHeader(
    filePath: string,
  ): Promise<PiRustSessionHeader | null> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const firstLine = content.split("\n")[0];
      if (!firstLine?.trim()) return null;
      const parsed = JSON.parse(firstLine);
      if (parsed.type !== "session") return null;
      return parsed as PiRustSessionHeader;
    } catch {
      return null;
    }
  }

  /** Extract the session ID from a JSONL filename (e.g., "2026-02-22T16-29-54.096Z_feb70071.jsonl" → "feb70071") */
  private extractShortId(filename: string): string {
    // Format: {timestamp}_{shortId}.jsonl
    const base = filename.replace(".jsonl", "");
    const parts = base.split("_");
    return parts[parts.length - 1];
  }

  private async buildSession(
    header: PiRustSessionHeader,
    filePath: string,
    projectCwd: string,
    runningPids: Map<number, PidInfo>,
  ): Promise<AgentSession> {
    const isRunning = await this.isSessionRunning(
      header,
      projectCwd,
      runningPids,
    );

    const { model, tokens, cost } = await this.parseSessionTail(filePath);
    const firstPrompt = await this.readFirstPrompt(filePath);

    let fileStat: Awaited<ReturnType<typeof fs.stat>> | undefined;
    try {
      fileStat = await fs.stat(filePath);
    } catch {
      // ignore
    }

    return {
      id: header.id,
      adapter: this.id,
      status: isRunning ? "running" : "stopped",
      startedAt: new Date(header.timestamp),
      stoppedAt: isRunning
        ? undefined
        : fileStat
          ? new Date(Number(fileStat.mtimeMs))
          : undefined,
      cwd: header.cwd || projectCwd,
      model: model || header.modelId,
      prompt: firstPrompt?.slice(0, 200),
      tokens,
      cost: cost ?? undefined,
      pid: isRunning
        ? await this.findMatchingPid(header, projectCwd, runningPids)
        : undefined,
      meta: {
        provider: header.provider,
        thinkingLevel: header.thinkingLevel,
        projectDir: projectCwd,
        sessionFile: filePath,
      },
    };
  }

  private async isSessionRunning(
    header: PiRustSessionHeader,
    projectCwd: string,
    runningPids: Map<number, PidInfo>,
  ): Promise<boolean> {
    const sessionCreated = new Date(header.timestamp).getTime();

    // 1. Check running PIDs discovered via `ps aux`
    for (const [, info] of runningPids) {
      if (info.args.includes(header.id)) {
        if (this.processStartedAfterSession(info, sessionCreated)) return true;
        continue;
      }
      if (info.cwd === projectCwd) {
        if (this.processStartedAfterSession(info, sessionCreated)) return true;
      }
    }

    // 2. Check persisted session metadata
    const meta = await this.readSessionMeta(header.id);
    if (meta?.pid) {
      if (this.isProcessAlive(meta.pid)) {
        const pidInfo = runningPids.get(meta.pid);
        if (pidInfo?.startTime && meta.startTime) {
          const currentStartMs = new Date(pidInfo.startTime).getTime();
          const recordedStartMs = new Date(meta.startTime).getTime();
          if (
            !Number.isNaN(currentStartMs) &&
            !Number.isNaN(recordedStartMs) &&
            Math.abs(currentStartMs - recordedStartMs) > 5000
          ) {
            await this.deleteSessionMeta(header.id);
            return false;
          }
        }

        if (meta.startTime) {
          const metaStartMs = new Date(meta.startTime).getTime();
          const sessionMs = new Date(meta.launchedAt).getTime();
          if (!Number.isNaN(metaStartMs) && metaStartMs >= sessionMs - 5000) {
            return true;
          }
          await this.deleteSessionMeta(header.id);
          return false;
        }
        return true;
      }
      await this.deleteSessionMeta(header.id);
    }

    return false;
  }

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
    header: PiRustSessionHeader,
    projectCwd: string,
    runningPids: Map<number, PidInfo>,
  ): Promise<number | undefined> {
    const sessionCreated = new Date(header.timestamp).getTime();

    for (const [pid, info] of runningPids) {
      if (info.args.includes(header.id)) {
        if (this.processStartedAfterSession(info, sessionCreated)) return pid;
        continue;
      }
      if (info.cwd === projectCwd) {
        if (this.processStartedAfterSession(info, sessionCreated)) return pid;
      }
    }

    const meta = await this.readSessionMeta(header.id);
    if (meta?.pid && this.isProcessAlive(meta.pid)) {
      return meta.pid;
    }

    return undefined;
  }

  private async parseSessionTail(filePath: string): Promise<{
    model?: string;
    tokens?: { in: number; out: number };
    cost?: number;
  }> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.trim().split("\n");

      let model: string | undefined;
      let totalIn = 0;
      let totalOut = 0;
      let totalCost = 0;

      const tail = lines.slice(-100);
      for (const line of tail) {
        try {
          const msg = JSON.parse(line) as PiRustMessage;
          if (msg.type === "message" && msg.message?.role === "assistant") {
            if (msg.message.model) model = msg.message.model;
            if (msg.message.usage) {
              totalIn += msg.message.usage.input || 0;
              totalOut += msg.message.usage.output || 0;
              if (msg.message.usage.cost?.total) {
                totalCost += msg.message.usage.cost.total;
              }
            }
          }
        } catch {
          // skip
        }
      }

      if (!model) {
        const head = lines.slice(0, 20);
        for (const line of head) {
          try {
            const msg = JSON.parse(line) as PiRustMessage;
            if (
              msg.type === "message" &&
              msg.message?.role === "assistant" &&
              msg.message?.model
            ) {
              model = msg.message.model;
              break;
            }
            // Also check session header for modelId
            if (
              msg.type === "session" &&
              (msg as unknown as PiRustSessionHeader).modelId
            ) {
              model = (msg as unknown as PiRustSessionHeader).modelId;
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
        cost: totalCost || undefined,
      };
    } catch {
      return {};
    }
  }

  /** Read the first user prompt from a JSONL session file */
  private async readFirstPrompt(filePath: string): Promise<string | undefined> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      for (const line of content.split("\n").slice(0, 20)) {
        try {
          const msg = JSON.parse(line) as PiRustMessage;
          if (
            msg.type === "message" &&
            msg.message?.role === "user" &&
            msg.message?.content
          ) {
            return extractTextContent(msg.message.content);
          }
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
    return undefined;
  }

  /** Find a session JSONL file by session ID (full or prefix match) */
  private async findSessionFile(sessionId: string): Promise<string | null> {
    let projectDirs: string[];
    try {
      const entries = await fs.readdir(this.sessionDir);
      projectDirs = entries.filter((e) => e.startsWith("--"));
    } catch {
      return null;
    }

    for (const projDir of projectDirs) {
      const projPath = path.join(this.sessionDir, projDir);
      const stat = await fs.stat(projPath).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const files = await this.getSessionFiles(projPath);
      for (const file of files) {
        const filePath = path.join(projPath, file);
        const header = await this.readSessionHeader(filePath);
        if (!header) continue;

        // Full match or prefix match
        if (header.id === sessionId || header.id.startsWith(sessionId)) {
          return filePath;
        }

        // Also check if the short ID in the filename matches
        const shortId = this.extractShortId(file);
        if (shortId === sessionId || sessionId.startsWith(shortId)) {
          return filePath;
        }
      }
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

/**
 * Decode a Pi Rust project directory name back to the original path.
 * Pi Rust encodes paths: "/" → "-", wrapped in "--".
 * E.g., "--private-tmp-test-pi-rust--" → "/private/tmp/test-pi-rust"
 *
 * Note: This is a lossy encoding — hyphens in the original path are
 * indistinguishable from path separators. We do our best to reconstruct.
 */
export function decodeProjDir(dirName: string): string {
  // Strip leading/trailing "--"
  let inner = dirName;
  if (inner.startsWith("--")) inner = inner.slice(2);
  if (inner.endsWith("--")) inner = inner.slice(0, -2);

  // Replace "-" with "/"
  return `/${inner.replace(/-/g, "/")}`;
}

/**
 * Encode a path as a Pi Rust project directory name.
 * E.g., "/private/tmp/test-pi-rust" → "--private-tmp-test-pi-rust--"
 */
export function encodeProjDir(cwdPath: string): string {
  // Strip leading "/" and replace remaining "/" and "-" with "-"
  const stripped = cwdPath.startsWith("/") ? cwdPath.slice(1) : cwdPath;
  const encoded = stripped.replace(/\//g, "-");
  return `--${encoded}--`;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getPiRustPids(): Promise<Map<number, PidInfo>> {
  const pids = new Map<number, PidInfo>();

  try {
    const { stdout } = await execFileAsync("ps", ["aux"]);

    for (const line of stdout.split("\n")) {
      if (!line.includes("pi-rust") || line.includes("grep")) continue;

      const fields = line.trim().split(/\s+/);
      if (fields.length < 11) continue;
      const pid = parseInt(fields[1], 10);
      const command = fields.slice(10).join(" ");

      // Match pi-rust processes (the binary, not wrappers)
      if (!command.includes("pi-rust")) continue;
      if (pid === process.pid) continue;

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

/**
 * Parse a "provider/model" string into separate provider and model parts.
 * If `explicitProvider` is given, it takes precedence over the prefix.
 * A plain model string (no slash) returns provider = undefined.
 */
export function parseProviderModel(
  raw: string,
  explicitProvider?: string,
): { provider: string | undefined; model: string } {
  if (explicitProvider) {
    // Strip provider prefix from model if it matches
    const prefixWithSlash = `${explicitProvider}/`;
    const model = raw.startsWith(prefixWithSlash)
      ? raw.slice(prefixWithSlash.length)
      : raw;
    return { provider: explicitProvider, model };
  }

  const slashIdx = raw.indexOf("/");
  if (slashIdx > 0 && slashIdx < raw.length - 1) {
    return {
      provider: raw.slice(0, slashIdx),
      model: raw.slice(slashIdx + 1),
    };
  }

  return { provider: undefined, model: raw };
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
