import { execFile } from "node:child_process";
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

/** The binary name for Slate CLI (@randomlabs/slate) */
export const SLATE_BINARY = "slate";

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
 * Extended metadata stored alongside the standard LaunchedSessionMeta.
 * We store cwd, model, prompt, and logPath since Slate's -q mode in v1.0.15
 * produces no output, so we track sessions via PID metadata.
 */
interface SlateExtendedMeta {
  cwd?: string;
  model?: string;
  prompt?: string;
  logPath?: string;
}

/**
 * Slate adapter — launches and monitors Slate coding agent sessions.
 *
 * Slate is a TUI-based coding agent by Random Labs (@randomlabs/slate).
 * Key CLI characteristics (v1.0.15):
 * - Binary: `slate` (npm: @randomlabs/slate)
 * - Prompt: `-q, --question <text>` to start with an initial question
 * - Output: `--output-format stream-json` for JSONL output, or `--stream-json`
 * - Permissions: `--dangerously-set-permissions` or env SLATE_DANGEROUS_SKIP_PERMISSIONS=1
 * - Workspace: `-w, --workspace <path>` for workspace directories
 * - Resume: `--resume <session-id>` for specific session, or `-c` for latest
 * - No --model flag (model configured via slate.json `models.main.default`)
 *
 * KNOWN ISSUE: In v1.0.15, `-q` mode produces empty stdout with exit 0.
 * This appears to be a bug in Slate where non-interactive invocations silently
 * skip the LLM call. The adapter still launches correctly (process runs),
 * but stream-json output may be empty. Interactive mode (`slate` with TUI) works.
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
    const runningPids = await this.getPids();
    const results: DiscoveredSession[] = [];

    try {
      const files = await fs.readdir(this.sessionsMetaDir);
      for (const file of files) {
        if (!file.endsWith(".json") || file.endsWith(".ext.json")) continue;
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

          const ext = await this.readExtendedMeta(meta.sessionId);

          results.push({
            id: meta.sessionId,
            status: isRunning ? "running" : "stopped",
            adapter: this.id,
            cwd: ext?.cwd,
            model: ext?.model,
            startedAt: meta.launchedAt ? new Date(meta.launchedAt) : undefined,
            stoppedAt: isRunning
              ? undefined
              : meta.launchedAt
                ? new Date(meta.launchedAt)
                : undefined,
            pid: isRunning ? meta.pid : undefined,
            prompt: ext?.prompt?.slice(0, 200),
          });
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // sessionsMetaDir doesn't exist yet
    }

    // Discover running slate processes not launched by us
    for (const [pid, info] of runningPids) {
      const alreadyTracked = results.some(
        (r) => r.pid === pid && r.status === "running",
      );
      if (alreadyTracked) continue;

      results.push({
        id: `slate-pid-${pid}`,
        status: "running",
        adapter: this.id,
        cwd: info.cwd || undefined,
        pid,
        nativeMetadata: { args: info.args },
      });
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
    let sessions: AgentSession[] = discovered.map((d) => ({
      id: d.id,
      adapter: d.adapter,
      status: d.status === "running" ? "running" : "stopped",
      startedAt: d.startedAt || new Date(),
      stoppedAt: d.stoppedAt,
      cwd: d.cwd,
      model: d.model,
      prompt: d.prompt,
      pid: d.pid,
      meta: d.nativeMetadata || {},
    }));

    if (opts?.status) {
      sessions = sessions.filter((s) => s.status === opts.status);
    } else if (!opts?.all) {
      sessions = sessions.filter(
        (s) => s.status === "running" || s.status === "idle",
      );
    }

    if (!opts?.all) {
      sessions = sessions.filter((s) => {
        if (s.status === "stopped") {
          const age = Date.now() - s.startedAt.getTime();
          return age <= STOPPED_SESSION_MAX_AGE_MS;
        }
        return true;
      });
    }

    sessions.sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;
      return b.startedAt.getTime() - a.startedAt.getTime();
    });

    return sessions;
  }

  async peek(sessionId: string, opts?: PeekOpts): Promise<string> {
    const n = opts?.lines ?? 20;

    const ext = await this.readExtendedMeta(sessionId);
    if (ext?.logPath) {
      try {
        const content = await fs.readFile(ext.logPath, "utf-8");
        const lines = content.trim().split("\n");
        return lines.slice(-n).join("\n") || "(no output captured)";
      } catch {
        // log file unreadable
      }
    }

    const meta = await readSessionMeta(this.sessionsMetaDir, sessionId);
    if (!meta) throw new Error(`Session not found: ${sessionId}`);

    return [
      "(Slate session — output may be empty due to v1.0.15 -q mode bug)",
      `Session: ${meta.sessionId}`,
      `PID: ${meta.pid}`,
      `Launched: ${meta.launchedAt}`,
    ].join("\n");
  }

  async status(sessionId: string): Promise<AgentSession> {
    const meta = await readSessionMeta(this.sessionsMetaDir, sessionId);
    if (!meta) throw new Error(`Session not found: ${sessionId}`);

    const runningPids = await this.getPids();
    const isRunning = meta.pid
      ? this.isPidAlive(meta.pid, meta.startTime, runningPids)
      : false;

    const ext = await this.readExtendedMeta(sessionId);

    return {
      id: meta.sessionId,
      adapter: this.id,
      status: isRunning ? "running" : "stopped",
      startedAt: new Date(meta.launchedAt),
      stoppedAt: isRunning ? undefined : new Date(meta.launchedAt),
      cwd: ext?.cwd,
      model: ext?.model,
      prompt: ext?.prompt?.slice(0, 200),
      pid: isRunning ? meta.pid : undefined,
      meta: { logPath: ext?.logPath },
    };
  }

  async launch(opts: LaunchOpts): Promise<AgentSession> {
    const args = buildSlateArgs(opts);
    const env = buildSpawnEnv(opts.env);
    const cwd = opts.cwd || process.cwd();

    await fs.mkdir(this.sessionsMetaDir, { recursive: true });
    const logPath = path.join(this.sessionsMetaDir, `launch-${Date.now()}.log`);
    const logFd = await fs.open(logPath, "w");

    const child = await spawnWithRetry(SLATE_BINARY, args, {
      cwd,
      env,
      stdio: ["ignore", logFd.fd, logFd.fd],
      detached: true,
    });

    child.unref();

    const pid = child.pid;
    const now = new Date();

    await logFd.close();

    const sessionId = crypto.randomUUID();

    if (pid) {
      await writeSessionMeta(this.sessionsMetaDir, { sessionId, pid });
      await this.writeExtendedMeta(sessionId, {
        cwd,
        model: opts.model,
        prompt: opts.prompt,
        logPath,
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

  async stop(sessionId: string, opts?: StopOpts): Promise<void> {
    const meta = await readSessionMeta(this.sessionsMetaDir, sessionId);
    if (!meta?.pid) {
      throw new Error(`No running process for session: ${sessionId}`);
    }

    if (!this.isProcessAlive(meta.pid)) {
      throw new Error(`Process already dead for session: ${sessionId}`);
    }

    if (opts?.force) {
      process.kill(meta.pid, "SIGINT");
      await sleep(5000);
      try {
        process.kill(meta.pid, "SIGKILL");
      } catch {
        // Already dead
      }
    } else {
      process.kill(meta.pid, "SIGTERM");
    }
  }

  async resume(sessionId: string, _message: string): Promise<void> {
    // Slate supports --resume <session-id> for specific sessions,
    // and -c for the latest session in a workspace.
    const ext = await this.readExtendedMeta(sessionId);
    const cwd = ext?.cwd || process.cwd();

    const slatePath = await resolveBinaryPath(SLATE_BINARY);
    const child = (await import("node:child_process")).spawn(
      slatePath,
      ["--resume", sessionId],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      },
    );

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
          }
        }

        knownSessions = currentMap;
      }
    } finally {
      // Nothing to clean up
    }
  }

  // --- Private helpers ---

  private isPidAlive(
    pid: number,
    recordedStartTime: string | undefined,
    runningPids: Map<number, PidInfo>,
  ): boolean {
    if (!this.isProcessAlive(pid)) return false;

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

  private async writeExtendedMeta(
    sessionId: string,
    ext: SlateExtendedMeta,
  ): Promise<void> {
    const extPath = path.join(this.sessionsMetaDir, `${sessionId}.ext.json`);
    await fs.writeFile(extPath, JSON.stringify(ext, null, 2));
  }

  private async readExtendedMeta(
    sessionId: string,
  ): Promise<SlateExtendedMeta | null> {
    const extPath = path.join(this.sessionsMetaDir, `${sessionId}.ext.json`);
    try {
      const raw = await fs.readFile(extPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

// --- Exported helpers ---

/**
 * Build CLI arguments for slate launch.
 * Exported for testing.
 *
 * Slate CLI flags (v1.0.15):
 * - `-q, --question <text>` — Start with an initial question
 * - `--output-format stream-json` — JSONL output for scripting
 * - `--stream-json` — Shorthand for --output-format stream-json
 * - `--dangerously-set-permissions` — Bypass permission prompts
 * - `-w, --workspace <path>` — Workspace directory
 * - `--resume <id>` — Resume a specific session
 * - `-c, --continue` — Resume latest session in workspace
 * - No --model flag (model configured via slate.json)
 */
export function buildSlateArgs(opts: LaunchOpts): string[] {
  const args: string[] = [];

  // -q is the question/prompt flag
  args.push("-q", opts.prompt);

  // Request structured JSONL output for stream parsing
  args.push("--output-format", "stream-json");

  // Bypass permission prompts for non-interactive use
  args.push("--dangerously-set-permissions");

  // Set workspace if cwd is provided
  if (opts.cwd) {
    args.push("-w", opts.cwd);
  }

  return args;
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

/** Discover running slate processes via `ps aux` */
async function getSlatePids(): Promise<Map<number, PidInfo>> {
  const pids = new Map<number, PidInfo>();

  try {
    const { stdout } = await execFileAsync("ps", ["aux"]);

    const candidates: Array<{ pid: number; command: string }> = [];
    for (const line of stdout.split("\n")) {
      if (!line.includes("slate") || line.includes("grep")) continue;

      const fields = line.trim().split(/\s+/);
      if (fields.length < 11) continue;
      const pid = parseInt(fields[1], 10);
      const command = fields.slice(10).join(" ");

      // Match slate binary — exclude unrelated processes that happen
      // to contain "slate" in their path (e.g. node_modules/translate)
      if (!isSlateCommand(command)) continue;
      if (pid === process.pid) continue;

      candidates.push({ pid, command });
    }

    if (candidates.length === 0) return pids;

    const pidList = candidates.map((c) => c.pid);

    // Batch lsof for cwds
    const cwdMap = new Map<number, string>();
    try {
      const { stdout: lsofOut } = await execFileAsync("/usr/sbin/lsof", [
        "-p",
        pidList.join(","),
        "-Fn",
        "-d",
        "cwd",
      ]);
      let currentPid = 0;
      for (const lsofLine of lsofOut.split("\n")) {
        if (lsofLine.startsWith("p")) {
          currentPid = parseInt(lsofLine.slice(1), 10);
        } else if (lsofLine.startsWith("n") && currentPid) {
          cwdMap.set(currentPid, lsofLine.slice(1));
        }
      }
    } catch {
      // lsof might fail
    }

    // Batch ps for start times
    const startTimeMap = new Map<number, string>();
    try {
      const { stdout: psOut } = await execFileAsync("ps", [
        "-p",
        pidList.join(","),
        "-o",
        "pid=,lstart=",
      ]);
      for (const psLine of psOut.trim().split("\n")) {
        const trimmed = psLine.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^(\d+)\s+(.+)$/);
        if (match) {
          startTimeMap.set(parseInt(match[1], 10), match[2].trim());
        }
      }
    } catch {
      // ps might fail
    }

    for (const { pid, command } of candidates) {
      pids.set(pid, {
        pid,
        cwd: cwdMap.get(pid) || "",
        args: command,
        startTime: startTimeMap.get(pid),
      });
    }
  } catch {
    // ps failed — return empty
  }

  return pids;
}

/** Check if a ps command string is a slate process */
function isSlateCommand(command: string): boolean {
  // Match: "slate -q ...", "slate --question ...", "/path/to/slate ...",
  // or the native binary "slate-darwin-arm64"
  return (
    /\bslate\b/.test(command) &&
    !command.includes("agentctl") &&
    !command.includes("translate")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
