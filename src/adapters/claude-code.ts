import { execFile, spawn } from "node:child_process";
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

const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), ".claude");

// Default: only show stopped sessions from the last 7 days
const STOPPED_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PidInfo {
  pid: number;
  cwd: string;
  args: string;
}

export interface ClaudeCodeAdapterOpts {
  claudeDir?: string; // Override ~/.claude for testing
  getPids?: () => Promise<Map<number, PidInfo>>; // Override PID detection for testing
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
  private readonly getPids: () => Promise<Map<number, PidInfo>>;

  constructor(opts?: ClaudeCodeAdapterOpts) {
    this.claudeDir = opts?.claudeDir || DEFAULT_CLAUDE_DIR;
    this.projectsDir = path.join(this.claudeDir, "projects");
    this.getPids = opts?.getPids || getClaudePids;
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
    if (!entry)
      throw new Error(`Session not found: ${sessionId}`);

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

    const child = spawn("claude", args, {
      cwd: opts.cwd || process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    // Unref so the parent process can exit
    child.unref();

    const session: AgentSession = {
      id: `pending-${child.pid}`,
      adapter: this.id,
      status: "running",
      startedAt: new Date(),
      cwd: opts.cwd || process.cwd(),
      model: opts.model,
      prompt: opts.prompt.slice(0, 200),
      pid: child.pid,
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
          } else if (prev.status === "running" && session.status === "stopped") {
            yield {
              type: "session.stopped",
              adapter: this.id,
              sessionId: id,
              session,
              timestamp: new Date(),
            };
          } else if (
            prev.status === "running" &&
            session.status === "idle"
          ) {
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
    projDirName: string,
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

    const results: Array<{ entry: SessionIndexEntry; index: SessionIndex }> = [];

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

      let fileStat;
      try {
        fileStat = await fs.stat(fullPath);
      } catch {
        continue;
      }

      // Read first few lines for prompt and cwd
      let firstPrompt = "";
      let sessionCwd = "";
      try {
        const content = await fs.readFile(fullPath, "utf-8");
        for (const l of content.split("\n").slice(0, 20)) {
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
    const isRunning = await this.isSessionRunning(
      entry,
      index,
      runningPids,
    );

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
        ? this.findMatchingPid(entry, index, runningPids)
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

    for (const [, info] of runningPids) {
      if (info.cwd === projectPath) return true;
      // Also check if the session ID appears in the command args
      if (info.args.includes(entry.sessionId)) return true;
    }

    // Fallback: check if JSONL was modified very recently (last 60s)
    try {
      const stat = await fs.stat(entry.fullPath);
      const age = Date.now() - stat.mtimeMs;
      if (age < 60_000) {
        // Double-check: is there any claude process running?
        return runningPids.size > 0;
      }
    } catch {
      // file doesn't exist
    }

    return false;
  }

  private findMatchingPid(
    entry: SessionIndexEntry,
    index: SessionIndex,
    runningPids: Map<number, PidInfo>,
  ): number | undefined {
    const projectPath = index.originalPath || entry.projectPath;

    for (const [pid, info] of runningPids) {
      if (info.cwd === projectPath) return pid;
      if (info.args.includes(entry.sessionId)) return pid;
    }

    return undefined;
  }

  private async parseSessionTail(
    jsonlPath: string,
  ): Promise<{ model?: string; tokens?: { in: number; out: number } }> {
    try {
      const content = await fs.readFile(jsonlPath, "utf-8");
      const lines = content.trim().split("\n");

      let model: string | undefined;
      let totalIn = 0;
      let totalOut = 0;

      // Read from the end for efficiency — last 100 lines
      const tail = lines.slice(-100);
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
        const head = lines.slice(0, 20);
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
        tokens: totalIn || totalOut ? { in: totalIn, out: totalOut } : undefined,
      };
    } catch {
      return {};
    }
  }

  private async findSessionFile(
    sessionId: string,
  ): Promise<string | null> {
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

  private async findPidForSession(
    sessionId: string,
  ): Promise<number | null> {
    const session = await this.status(sessionId);
    return session.pid ?? null;
  }
}

// --- Utility functions ---

async function getClaudePids(): Promise<Map<number, PidInfo>> {
  const pids = new Map<number, PidInfo>();

  try {
    const { stdout } = await execFileAsync("ps", [
      "aux",
    ]);

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

      pids.set(pid, { pid, cwd, args: command });
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
      .map((b) => b.text!)
      .join("\n");
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
