import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync, watch } from "node:fs";
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

const DEFAULT_CODEX_DIR = path.join(os.homedir(), ".codex");

// Default: only show stopped sessions from the last 7 days
const STOPPED_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CodexPidInfo {
  pid: number;
  cwd: string;
  args: string;
  startTime?: string;
}

/** Metadata persisted by launch() so status checks survive wrapper exit */
export interface CodexSessionMeta {
  sessionId: string;
  pid: number;
  startTime?: string;
  wrapperPid?: number;
  cwd: string;
  model?: string;
  prompt?: string;
  launchedAt: string;
}

/** Parsed session info from a Codex JSONL file */
interface CodexSessionInfo {
  id: string;
  cwd?: string;
  model?: string;
  cliVersion?: string;
  firstPrompt?: string;
  lastMessage?: string;
  tokens?: { in: number; out: number };
  created: Date;
  modified: Date;
  filePath: string;
}

/** Structure of the session_meta payload in Codex JSONL */
interface CodexSessionMetaPayload {
  id: string;
  cwd?: string;
  model_provider?: string;
  cli_version?: string;
  source?: string;
}

/** Structure of a Codex JSONL line */
interface CodexJSONLLine {
  timestamp: string;
  type: string;
  payload?: {
    id?: string;
    cwd?: string;
    model_provider?: string;
    cli_version?: string;
    source?: string;
    type?: string;
    role?: string;
    message?: string;
    text?: string;
    turn_id?: string;
    model?: string;
    content?: Array<{ type: string; text?: string }>;
    item?: {
      id?: string;
      type?: string;
      text?: string;
    };
    info?: {
      total_token_usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };
  };
  thread_id?: string;
}

export interface CodexAdapterOpts {
  codexDir?: string;
  sessionsMetaDir?: string;
  getPids?: () => Promise<Map<number, CodexPidInfo>>;
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Codex CLI adapter — reads session data from ~/.codex/sessions/
 * and cross-references with running PIDs.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  private readonly codexDir: string;
  private readonly sessionsDir: string;
  private readonly sessionsMetaDir: string;
  private readonly getPids: () => Promise<Map<number, CodexPidInfo>>;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(opts?: CodexAdapterOpts) {
    this.codexDir = opts?.codexDir || DEFAULT_CODEX_DIR;
    this.sessionsDir = path.join(this.codexDir, "sessions");
    this.sessionsMetaDir =
      opts?.sessionsMetaDir || path.join(this.codexDir, "agentctl", "sessions");
    this.getPids = opts?.getPids || getCodexPids;
    this.isProcessAlive = opts?.isProcessAlive || defaultIsProcessAlive;
  }

  async discover(): Promise<DiscoveredSession[]> {
    const runningPids = await this.getPids();
    const sessionInfos = await this.discoverSessions();
    const results: DiscoveredSession[] = [];

    for (const info of sessionInfos) {
      const isRunning = this.isSessionRunning(info, runningPids);
      const pid = isRunning
        ? this.findMatchingPid(info, runningPids)
        : undefined;

      results.push({
        id: info.id,
        status: isRunning ? "running" : "stopped",
        adapter: this.id,
        cwd: info.cwd,
        model: info.model,
        startedAt: info.created,
        stoppedAt: isRunning ? undefined : info.modified,
        pid,
        prompt: info.firstPrompt,
        tokens: info.tokens,
        nativeMetadata: {
          cliVersion: info.cliVersion,
          lastMessage: info.lastMessage,
        },
      });
    }

    return results;
  }

  async isAlive(sessionId: string): Promise<boolean> {
    const runningPids = await this.getPids();
    const info = await this.findSession(sessionId);
    if (!info) return false;
    return this.isSessionRunning(info, runningPids);
  }

  async list(opts?: ListOpts): Promise<AgentSession[]> {
    const runningPids = await this.getPids();
    const sessionInfos = await this.discoverSessions();
    const sessions: AgentSession[] = [];

    for (const info of sessionInfos) {
      const session = this.buildSession(info, runningPids);

      if (opts?.status && session.status !== opts.status) continue;

      if (!opts?.all && !opts?.status && session.status === "stopped") {
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

      sessions.push(session);
    }

    sessions.sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;
      return b.startedAt.getTime() - a.startedAt.getTime();
    });

    return sessions;
  }

  async peek(sessionId: string, opts?: PeekOpts): Promise<string> {
    const lines = opts?.lines ?? 20;
    const info = await this.findSession(sessionId);
    if (!info) throw new Error(`Session not found: ${sessionId}`);

    const content = await fs.readFile(info.filePath, "utf-8");
    const jsonlLines = content.trim().split("\n");

    const messages: string[] = [];
    for (const line of jsonlLines) {
      try {
        const parsed = JSON.parse(line) as CodexJSONLLine;
        // Extract agent messages from event_msg type (primary source)
        if (
          parsed.type === "event_msg" &&
          parsed.payload?.type === "agent_message" &&
          parsed.payload.message
        ) {
          messages.push(parsed.payload.message);
        }
      } catch {
        // skip malformed lines
      }
    }

    const recent = messages.slice(-lines);
    return recent.join("\n---\n");
  }

  async status(sessionId: string): Promise<AgentSession> {
    const runningPids = await this.getPids();
    const info = await this.findSession(sessionId);
    if (!info) throw new Error(`Session not found: ${sessionId}`);

    return this.buildSession(info, runningPids);
  }

  async launch(opts: LaunchOpts): Promise<AgentSession> {
    const args = [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
    ];

    if (opts.model) {
      args.push("--model", opts.model);
    }

    const cwd = opts.cwd || process.cwd();
    args.push("--cd", cwd);
    args.push(opts.prompt);

    const env = buildSpawnEnv(undefined, opts.env);

    await fs.mkdir(this.sessionsMetaDir, { recursive: true });
    const logPath = path.join(this.sessionsMetaDir, `launch-${Date.now()}.log`);
    const logFd = await fs.open(logPath, "w");

    const codexPath = await resolveBinaryPath("codex");
    const child = spawn(codexPath, args, {
      cwd,
      env,
      stdio: ["ignore", logFd.fd, "ignore"],
      detached: true,
    });

    child.on("error", (err) => {
      console.error(`[codex] spawn error: ${err.message}`);
    });

    child.unref();

    const pid = child.pid;
    const now = new Date();

    await logFd.close();

    // Poll for thread_id from JSONL output
    let resolvedSessionId: string | undefined;
    if (pid) {
      resolvedSessionId = await this.pollForSessionId(logPath, pid, 10000);
    }

    const sessionId =
      resolvedSessionId || (pid ? `pending-${pid}` : crypto.randomUUID());

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

    return {
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
  }

  /**
   * Poll the launch log file for up to `timeoutMs` to extract the session/thread ID.
   * Codex outputs {"type":"thread.started","thread_id":"..."} early in its JSONL stream.
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
            const msg = JSON.parse(line) as CodexJSONLLine;
            // Look for thread.started event
            if (msg.thread_id) {
              return msg.thread_id;
            }
            // Also check session_meta payload
            if (msg.type === "session_meta" && msg.payload?.id) {
              return msg.payload.id;
            }
          } catch {
            // Not valid JSON yet
          }
        }
      } catch {
        // File may not exist yet
      }
      try {
        process.kill(pid, 0);
      } catch {
        break;
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
    const session = await this.findSession(sessionId);
    const cwd = session?.cwd || process.cwd();

    const args = [
      "exec",
      "resume",
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      sessionId,
      message,
    ];

    const codexPath = await resolveBinaryPath("codex");
    const child = spawn(codexPath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    child.on("error", (err) => {
      console.error(`[codex] resume spawn error: ${err.message}`);
    });

    child.unref();
  }

  async *events(): AsyncIterable<LifecycleEvent> {
    let knownSessions = new Map<string, AgentSession>();

    const initial = await this.list({ all: true });
    for (const s of initial) {
      knownSessions.set(s.id, s);
    }

    const watchDir = this.sessionsDir;
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      await fs.access(watchDir);
      watcher = watch(watchDir, { recursive: true });
    } catch {
      // Sessions dir may not exist yet
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
   * Discover all Codex sessions by scanning ~/.codex/sessions/ recursively.
   * Sessions are stored as: sessions/YYYY/MM/DD/rollout-<datetime>-<session-id>.jsonl
   */
  private async discoverSessions(): Promise<CodexSessionInfo[]> {
    const sessions: CodexSessionInfo[] = [];

    const jsonlFiles = await this.findJsonlFiles(this.sessionsDir);

    for (const filePath of jsonlFiles) {
      try {
        const info = await this.parseSessionFile(filePath);
        if (info) sessions.push(info);
      } catch {
        // Skip unparseable files
      }
    }

    // Also check persisted metadata for sessions not yet in ~/.codex/sessions/
    try {
      const metaFiles = await fs.readdir(this.sessionsMetaDir);
      for (const file of metaFiles) {
        if (!file.endsWith(".json") || file.startsWith("launch-")) continue;
        try {
          const raw = await fs.readFile(
            path.join(this.sessionsMetaDir, file),
            "utf-8",
          );
          const meta = JSON.parse(raw) as CodexSessionMeta;
          // Skip if we already have this session from the sessions dir
          if (sessions.some((s) => s.id === meta.sessionId)) continue;
          sessions.push({
            id: meta.sessionId,
            cwd: meta.cwd,
            model: meta.model,
            firstPrompt: meta.prompt,
            created: new Date(meta.launchedAt),
            modified: new Date(meta.launchedAt),
            filePath: "",
          });
        } catch {
          // Skip
        }
      }
    } catch {
      // Dir doesn't exist
    }

    return sessions;
  }

  /** Recursively find all .jsonl files under a directory */
  private async findJsonlFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const nested = await this.findJsonlFiles(fullPath);
          results.push(...nested);
        } else if (entry.name.endsWith(".jsonl")) {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory doesn't exist
    }
    return results;
  }

  /** Parse a Codex session JSONL file to extract session info */
  private async parseSessionFile(
    filePath: string,
  ): Promise<CodexSessionInfo | null> {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    if (lines.length === 0 || !lines[0].trim()) return null;

    const stat = await fs.stat(filePath);

    let id: string | undefined;
    let cwd: string | undefined;
    let model: string | undefined;
    let cliVersion: string | undefined;
    let firstPrompt: string | undefined;
    let lastMessage: string | undefined;
    let sessionTimestamp: string | undefined;
    let totalIn = 0;
    let totalOut = 0;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as CodexJSONLLine;

        // Extract session ID from thread.started or session_meta
        if (parsed.thread_id && !id) {
          id = parsed.thread_id;
        }
        if (parsed.type === "session_meta" && parsed.payload) {
          const meta = parsed.payload as unknown as CodexSessionMetaPayload;
          if (meta.id) id = meta.id;
          if (meta.cwd) cwd = meta.cwd;
          if (meta.cli_version) cliVersion = meta.cli_version;
        }

        // Capture the earliest timestamp from the file
        if (parsed.timestamp && !sessionTimestamp) {
          sessionTimestamp = parsed.timestamp;
        }

        // Extract model from turn_context
        if (parsed.type === "turn_context" && parsed.payload?.model) {
          model = parsed.payload.model;
        }

        // Extract first user prompt
        if (
          parsed.type === "event_msg" &&
          parsed.payload?.type === "user_message" &&
          parsed.payload.message &&
          !firstPrompt
        ) {
          firstPrompt = parsed.payload.message;
        }

        // Extract agent messages
        if (
          parsed.type === "event_msg" &&
          parsed.payload?.type === "agent_message" &&
          parsed.payload.message
        ) {
          lastMessage = parsed.payload.message;
        }

        // Extract token usage
        if (
          parsed.type === "event_msg" &&
          parsed.payload?.type === "token_count" &&
          parsed.payload.info?.total_token_usage
        ) {
          const usage = parsed.payload.info.total_token_usage;
          totalIn = usage.input_tokens ?? 0;
          totalOut = usage.output_tokens ?? 0;
        }
      } catch {
        // skip malformed lines
      }
    }

    if (!id) {
      // Try to extract ID from filename:
      // rollout-2026-02-20T17-38-59-019c7dd9-9b86-7dc1-95fe-7b68b8fd260d.jsonl
      const basename = path.basename(filePath, ".jsonl");
      const uuidMatch = basename.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
      );
      if (uuidMatch) {
        id = uuidMatch[1];
      }
    }

    if (!id) return null;

    // Use session's own timestamp if available, fall back to file stat
    const created = sessionTimestamp
      ? new Date(sessionTimestamp)
      : stat.birthtime;

    return {
      id,
      cwd,
      model,
      cliVersion,
      firstPrompt: firstPrompt?.slice(0, 200),
      lastMessage,
      tokens: totalIn || totalOut ? { in: totalIn, out: totalOut } : undefined,
      created,
      modified: stat.mtime,
      filePath,
    };
  }

  private buildSession(
    info: CodexSessionInfo,
    runningPids: Map<number, CodexPidInfo>,
  ): AgentSession {
    const isRunning = this.isSessionRunning(info, runningPids);
    const pid = isRunning ? this.findMatchingPid(info, runningPids) : undefined;

    return {
      id: info.id,
      adapter: this.id,
      status: isRunning ? "running" : "stopped",
      startedAt: info.created,
      stoppedAt: isRunning ? undefined : info.modified,
      cwd: info.cwd,
      model: info.model,
      prompt: info.firstPrompt,
      tokens: info.tokens,
      pid,
      meta: {
        cliVersion: info.cliVersion,
        lastMessage: info.lastMessage,
      },
    };
  }

  private isSessionRunning(
    info: CodexSessionInfo,
    runningPids: Map<number, CodexPidInfo>,
  ): boolean {
    const sessionCreated = info.created.getTime();

    // 1. Check running PIDs from ps aux
    for (const [, pidInfo] of runningPids) {
      if (pidInfo.args.includes(info.id)) {
        if (this.processStartedAfterSession(pidInfo, sessionCreated))
          return true;
        continue;
      }
      if (info.cwd && pidInfo.cwd === info.cwd) {
        if (this.processStartedAfterSession(pidInfo, sessionCreated))
          return true;
      }
    }

    // 2. Check persisted session metadata
    const meta = this.readSessionMetaSync(info.id);
    if (meta?.pid) {
      if (this.isProcessAlive(meta.pid)) {
        // Cross-check start time for PID recycling
        const pidInfo = runningPids.get(meta.pid);
        if (pidInfo?.startTime && meta.startTime) {
          const currentStartMs = new Date(pidInfo.startTime).getTime();
          const recordedStartMs = new Date(meta.startTime).getTime();
          if (
            !Number.isNaN(currentStartMs) &&
            !Number.isNaN(recordedStartMs) &&
            Math.abs(currentStartMs - recordedStartMs) > 5000
          ) {
            return false;
          }
        }

        if (meta.startTime) {
          const metaStartMs = new Date(meta.startTime).getTime();
          const sessionMs = new Date(meta.launchedAt).getTime();
          if (!Number.isNaN(metaStartMs) && metaStartMs >= sessionMs - 5000) {
            return true;
          }
          return false;
        }
        return true;
      }
    }

    return false;
  }

  private processStartedAfterSession(
    info: CodexPidInfo,
    sessionCreatedMs: number,
  ): boolean {
    if (!info.startTime) return false;
    const processStartMs = new Date(info.startTime).getTime();
    if (Number.isNaN(processStartMs)) return false;
    return processStartMs >= sessionCreatedMs - 5000;
  }

  private findMatchingPid(
    info: CodexSessionInfo,
    runningPids: Map<number, CodexPidInfo>,
  ): number | undefined {
    const sessionCreated = info.created.getTime();

    for (const [pid, pidInfo] of runningPids) {
      if (pidInfo.args.includes(info.id)) {
        if (this.processStartedAfterSession(pidInfo, sessionCreated))
          return pid;
        continue;
      }
      if (info.cwd && pidInfo.cwd === info.cwd) {
        if (this.processStartedAfterSession(pidInfo, sessionCreated))
          return pid;
      }
    }

    const meta = this.readSessionMetaSync(info.id);
    if (meta?.pid && this.isProcessAlive(meta.pid)) {
      return meta.pid;
    }

    return undefined;
  }

  private async findSession(
    sessionId: string,
  ): Promise<CodexSessionInfo | null> {
    const sessions = await this.discoverSessions();

    // Exact match
    const exact = sessions.find((s) => s.id === sessionId);
    if (exact) return exact;

    // Prefix match
    const prefix = sessions.find((s) => s.id.startsWith(sessionId));
    return prefix || null;
  }

  private async findPidForSession(sessionId: string): Promise<number | null> {
    const session = await this.status(sessionId);
    return session.pid ?? null;
  }

  // --- Session metadata persistence ---

  async writeSessionMeta(
    meta: Omit<CodexSessionMeta, "startTime">,
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
      // Process may have already exited
    }

    const fullMeta: CodexSessionMeta = { ...meta, startTime };
    const metaPath = path.join(this.sessionsMetaDir, `${meta.sessionId}.json`);
    await fs.writeFile(metaPath, JSON.stringify(fullMeta, null, 2));
  }

  async readSessionMeta(sessionId: string): Promise<CodexSessionMeta | null> {
    const metaPath = path.join(this.sessionsMetaDir, `${sessionId}.json`);
    try {
      const raw = await fs.readFile(metaPath, "utf-8");
      return JSON.parse(raw) as CodexSessionMeta;
    } catch {
      // Not found
    }

    // Scan all metadata files for matching sessionId
    try {
      const files = await fs.readdir(this.sessionsMetaDir);
      for (const file of files) {
        if (!file.endsWith(".json") || file.startsWith("launch-")) continue;
        try {
          const raw = await fs.readFile(
            path.join(this.sessionsMetaDir, file),
            "utf-8",
          );
          const meta = JSON.parse(raw) as CodexSessionMeta;
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

  /**
   * Synchronous-style read of session metadata (reads from cache/disk).
   * Used by isSessionRunning which is called in a tight loop.
   * Falls back to null if not found.
   */
  private readSessionMetaSync(sessionId: string): CodexSessionMeta | null {
    const metaPath = path.join(this.sessionsMetaDir, `${sessionId}.json`);
    try {
      const raw = readFileSync(metaPath, "utf-8");
      return JSON.parse(raw) as CodexSessionMeta;
    } catch {
      return null;
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

async function getCodexPids(): Promise<Map<number, CodexPidInfo>> {
  const pids = new Map<number, CodexPidInfo>();

  try {
    const { stdout } = await execFileAsync("ps", ["aux"]);

    for (const line of stdout.split("\n")) {
      if (!line.includes("codex") || line.includes("grep")) continue;

      const fields = line.trim().split(/\s+/);
      if (fields.length < 11) continue;
      const pid = parseInt(fields[1], 10);
      const command = fields.slice(10).join(" ");

      // Match codex exec or codex with flags — exclude interactive sessions
      if (!command.startsWith("codex exec") && !command.startsWith("codex --"))
        continue;
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
    // ps failed
  }

  return pids;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
