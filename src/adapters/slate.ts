import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
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
  readSessionMeta,
  writeSessionMeta,
} from "../utils/session-meta.js";
import { spawnWithRetry } from "../utils/spawn-with-retry.js";

const execFileAsync = promisify(execFile);

const DEFAULT_SLATE_DIR = path.join(os.homedir(), ".slate");

const STOPPED_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PidInfo {
  pid: number;
  cwd: string;
  args: string;
  startTime?: string;
}

export interface SlateAdapterOpts {
  slateDir?: string;
  sessionsMetaDir?: string;
  getPids?: () => Promise<Map<number, PidInfo>>;
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Slate streams Claude Code SDK-compatible JSONL via --output-format stream-json.
 * We reuse the same message types.
 */
interface JSONLMessage {
  type: "user" | "assistant" | "error" | string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
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
  error?: string | { message?: string };
}

/**
 * Slate adapter — launches Slate with --output-format stream-json and
 * tracks sessions via PID + launch-log files.
 *
 * Slate's stream-json output is compatible with the Claude Code SDK,
 * so we reuse the same JSONL parsing approach.
 */
export class SlateAdapter implements AgentAdapter {
  readonly id = "slate";
  private readonly slateDir: string;
  private readonly sessionsMetaDir: string;
  private readonly getPids: () => Promise<Map<number, PidInfo>>;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(opts?: SlateAdapterOpts) {
    this.slateDir = opts?.slateDir || DEFAULT_SLATE_DIR;
    this.sessionsMetaDir =
      opts?.sessionsMetaDir || path.join(this.slateDir, "agentctl", "sessions");
    this.getPids = opts?.getPids || getSlatePids;
    this.isProcessAlive = opts?.isProcessAlive || defaultIsProcessAlive;
  }

  async discover(): Promise<DiscoveredSession[]> {
    cleanupExpiredMeta(this.sessionsMetaDir).catch(() => {});

    const results: DiscoveredSession[] = [];
    const runningPids = await this.getPids();

    // Discover from persisted session metadata (launched via agentctl)
    try {
      const files = await fs.readdir(this.sessionsMetaDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = await fs.readFile(
            path.join(this.sessionsMetaDir, file),
            "utf-8",
          );
          const meta = JSON.parse(raw);
          if (!meta.sessionId) continue;

          const isRunning = meta.pid
            ? this.isPidAlive(meta.pid, meta.startTime, runningPids)
            : false;

          const logData = meta.logPath
            ? await this.parseLogFile(meta.logPath)
            : undefined;

          results.push({
            id: meta.sessionId,
            status: isRunning ? "running" : "stopped",
            adapter: this.id,
            cwd: logData?.cwd,
            model: logData?.model,
            startedAt: meta.launchedAt ? new Date(meta.launchedAt) : undefined,
            stoppedAt: isRunning ? undefined : new Date(),
            pid: isRunning ? meta.pid : undefined,
            prompt: logData?.prompt?.slice(0, 200),
            tokens: logData?.tokens,
            cost: logData?.cost,
          });
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // sessionsMetaDir doesn't exist yet
    }

    return results;
  }

  async isAlive(sessionId: string): Promise<boolean> {
    const meta = await readSessionMeta(this.sessionsMetaDir, sessionId);
    if (!meta?.pid) return false;

    const runningPids = await this.getPids();
    return this.isPidAlive(meta.pid, meta.startTime, runningPids);
  }

  async list(opts?: ListOpts): Promise<AgentSession[]> {
    const discovered = await this.discover();
    const sessions: AgentSession[] = [];

    for (const disc of discovered) {
      const session: AgentSession = {
        id: disc.id,
        adapter: this.id,
        status: disc.status === "running" ? "running" : "stopped",
        startedAt: disc.startedAt || new Date(),
        stoppedAt: disc.stoppedAt,
        cwd: disc.cwd,
        model: disc.model,
        prompt: disc.prompt,
        tokens: disc.tokens,
        cost: disc.cost,
        pid: disc.pid,
        meta: {},
      };

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

    // Find the log file for this session
    const logPath = await this.getLogPathForSession(sessionId);
    if (!logPath) throw new Error(`Session not found: ${sessionId}`);

    const content = await fs.readFile(logPath, "utf-8");
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

    const recent = assistantMessages.slice(-lines);
    return recent.join("\n---\n");
  }

  async status(sessionId: string): Promise<AgentSession> {
    const meta = await readSessionMeta(this.sessionsMetaDir, sessionId);
    if (!meta) throw new Error(`Session not found: ${sessionId}`);

    const runningPids = await this.getPids();
    const isRunning = meta.pid
      ? this.isPidAlive(meta.pid, meta.startTime, runningPids)
      : false;

    const logData = meta.logPath
      ? await this.parseLogFile(meta.logPath)
      : undefined;

    return {
      id: meta.sessionId,
      adapter: this.id,
      status: isRunning ? "running" : "stopped",
      startedAt: meta.launchedAt ? new Date(meta.launchedAt) : new Date(),
      stoppedAt: isRunning ? undefined : new Date(),
      cwd: logData?.cwd,
      model: logData?.model,
      prompt: logData?.prompt?.slice(0, 200),
      tokens: logData?.tokens,
      cost: logData?.cost,
      pid: isRunning ? meta.pid : undefined,
      meta: { logPath: meta.logPath },
    };
  }

  async launch(opts: LaunchOpts): Promise<AgentSession> {
    const args = [
      "-q",
      "--output-format",
      "stream-json",
      "--dangerously-set-permissions",
    ];

    if (opts.cwd) {
      args.push("--workspace", opts.cwd);
    }

    if (opts.model) {
      args.push("--model", opts.model);
    }

    const useTempFile = isLargePrompt(opts.prompt);
    let promptFilePath: string | undefined;
    let promptFd: Awaited<ReturnType<typeof openPromptFd>> | undefined;

    if (useTempFile) {
      promptFilePath = await writePromptFile(opts.prompt);
      promptFd = await openPromptFd(promptFilePath);
    } else {
      args.push("-p", opts.prompt);
    }

    const cwd = opts.cwd || process.cwd();
    const env = buildSpawnEnv(opts.env);

    // Write stdout to a log file for session ID extraction and peek
    await fs.mkdir(this.sessionsMetaDir, { recursive: true });
    const logPath = path.join(this.sessionsMetaDir, `launch-${Date.now()}.log`);
    const logFd = await fs.open(logPath, "w");

    const child = await spawnWithRetry("slate", args, {
      cwd,
      env,
      stdio: [promptFd ? promptFd.fd : "ignore", logFd.fd, logFd.fd],
      detached: true,
    });

    child.unref();

    const pid = child.pid;
    const now = new Date();

    await logFd.close();
    if (promptFd) await promptFd.close();
    if (promptFilePath) await cleanupPromptFile(promptFilePath);

    // Poll for session ID from stream-json output
    let resolvedSessionId: string | undefined;
    if (pid) {
      const pollResult = await this.pollForSessionId(logPath, pid, 15000);
      if (pollResult.error) {
        throw new Error(`Slate launch failed: ${pollResult.error}`);
      }
      resolvedSessionId = pollResult.sessionId;
    }

    const sessionId = resolvedSessionId || crypto.randomUUID();

    if (pid) {
      await writeSessionMeta(this.sessionsMetaDir, { sessionId, pid });
      // Also store logPath in the meta file for peek fallback
      const metaPath = path.join(this.sessionsMetaDir, `${sessionId}.json`);
      try {
        const raw = await fs.readFile(metaPath, "utf-8");
        const meta = JSON.parse(raw);
        meta.logPath = logPath;
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
      } catch {
        // meta write failed — non-fatal
      }
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

  async stop(sessionId: string, opts?: StopOpts): Promise<void> {
    const meta = await readSessionMeta(this.sessionsMetaDir, sessionId);
    const pid = meta?.pid;
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
    const args = [
      "-q",
      "--output-format",
      "stream-json",
      "--dangerously-set-permissions",
      "--resume",
      sessionId,
      "-p",
      message,
    ];

    const session = await this.status(sessionId).catch(() => null);
    const cwd = session?.cwd || process.cwd();

    const slatePath = await resolveBinaryPath("slate");
    const child = spawn(slatePath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    child.on("error", (err) => {
      console.error(`[slate] resume spawn error: ${err.message}`);
    });

    child.unref();
  }

  async *events(): AsyncIterable<LifecycleEvent> {
    let knownSessions = new Map<string, AgentSession>();

    const initial = await this.list({ all: true });
    for (const s of initial) {
      knownSessions.set(s.id, s);
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
    } catch {
      // iterator closed
    }
  }

  // --- Private helpers ---

  private async pollForSessionId(
    logPath: string,
    pid: number,
    timeoutMs: number,
  ): Promise<{ sessionId?: string; error?: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const content = await fs.readFile(logPath, "utf-8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as JSONLMessage;
            if (msg.sessionId && typeof msg.sessionId === "string") {
              return { sessionId: msg.sessionId };
            }
            if (msg.type === "error" || msg.error) {
              const errMsg =
                typeof msg.error === "string"
                  ? msg.error
                  : (msg.error?.message ?? JSON.stringify(msg));
              return { error: errMsg };
            }
          } catch {
            // Not valid JSON yet — might be raw stderr
          }
        }
      } catch {
        // File may not exist yet
      }

      // Check if process is still alive
      try {
        process.kill(pid, 0);
      } catch {
        // Process died — try one final read
        return this.readLogForResult(logPath);
      }

      await sleep(200);
    }
    return {};
  }

  private async readLogForResult(
    logPath: string,
  ): Promise<{ sessionId?: string; error?: string }> {
    try {
      const content = await fs.readFile(logPath, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as JSONLMessage;
          if (msg.sessionId) return { sessionId: msg.sessionId };
          if (msg.type === "error" || msg.error) {
            const errMsg =
              typeof msg.error === "string"
                ? msg.error
                : (msg.error?.message ?? JSON.stringify(msg));
            return { error: errMsg };
          }
        } catch {
          // skip
        }
      }
    } catch {
      // file unreadable
    }
    return {};
  }

  private async getLogPathForSession(
    sessionId: string,
  ): Promise<string | null> {
    const meta = await readSessionMeta(this.sessionsMetaDir, sessionId);
    if (meta?.logPath) {
      try {
        await fs.access(meta.logPath);
        return meta.logPath;
      } catch {
        // log file gone
      }
    }

    // Scan for log files near the launch time
    if (meta?.launchedAt) {
      try {
        const files = await fs.readdir(this.sessionsMetaDir);
        const launchMs = new Date(meta.launchedAt).getTime();
        for (const file of files) {
          if (!file.startsWith("launch-") || !file.endsWith(".log")) continue;
          const tsStr = file.replace("launch-", "").replace(".log", "");
          const ts = Number(tsStr);
          if (!Number.isNaN(ts) && Math.abs(ts - launchMs) < 2000) {
            return path.join(this.sessionsMetaDir, file);
          }
        }
      } catch {
        // dir doesn't exist
      }
    }
    return null;
  }

  private async parseLogFile(logPath: string): Promise<{
    cwd?: string;
    model?: string;
    prompt?: string;
    tokens?: { in: number; out: number };
    cost?: number;
  }> {
    try {
      const content = await fs.readFile(logPath, "utf-8");
      const lines = content.trim().split("\n");

      let cwd: string | undefined;
      let model: string | undefined;
      let prompt: string | undefined;
      let totalIn = 0;
      let totalOut = 0;

      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as JSONLMessage;

          if (msg.cwd) cwd = msg.cwd;

          if (msg.type === "user" && msg.message?.content && !prompt) {
            prompt = extractTextContent(msg.message.content);
          }

          if (msg.type === "assistant" && msg.message) {
            if (msg.message.model) model = msg.message.model;
            if (msg.message.usage) {
              totalIn += msg.message.usage.input_tokens || 0;
              totalOut += msg.message.usage.output_tokens || 0;
            }
          }
        } catch {
          // skip malformed lines
        }
      }

      return {
        cwd,
        model,
        prompt,
        tokens:
          totalIn || totalOut ? { in: totalIn, out: totalOut } : undefined,
      };
    } catch {
      return {};
    }
  }

  private isPidAlive(
    pid: number,
    recordedStartTime: string | undefined,
    runningPids: Map<number, PidInfo>,
  ): boolean {
    if (!this.isProcessAlive(pid)) return false;

    // Cross-check for PID recycling
    if (recordedStartTime) {
      const pidInfo = runningPids.get(pid);
      if (pidInfo?.startTime) {
        const currentStartMs = new Date(pidInfo.startTime).getTime();
        const recordedStartMs = new Date(recordedStartTime).getTime();
        if (
          !Number.isNaN(currentStartMs) &&
          !Number.isNaN(recordedStartMs) &&
          Math.abs(currentStartMs - recordedStartMs) > 5000
        ) {
          return false; // PID recycled
        }
      }
    }

    return true;
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

async function getSlatePids(): Promise<Map<number, PidInfo>> {
  const pids = new Map<number, PidInfo>();

  try {
    const { stdout } = await execFileAsync("ps", ["aux"]);

    for (const line of stdout.split("\n")) {
      if (line.includes("grep")) continue;

      const fields = line.trim().split(/\s+/);
      if (fields.length < 11) continue;
      const pid = parseInt(fields[1], 10);
      const command = fields.slice(10).join(" ");

      // Match 'slate' command invocations with flags
      if (!command.startsWith("slate -") && !command.startsWith("slate --"))
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
