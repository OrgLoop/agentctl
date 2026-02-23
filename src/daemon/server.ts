import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { CodexAdapter } from "../adapters/codex.js";
import { OpenClawAdapter } from "../adapters/openclaw.js";
import { OpenCodeAdapter } from "../adapters/opencode.js";
import { PiAdapter } from "../adapters/pi.js";
import { PiRustAdapter } from "../adapters/pi-rust.js";
import type { AgentAdapter } from "../core/types.js";
import { migrateLocks } from "../migration/migrate-locks.js";
import { saveEnvironment } from "../utils/daemon-env.js";
import { clearBinaryCache } from "../utils/resolve-binary.js";
import { FuseEngine } from "./fuse-engine.js";
import { LockManager } from "./lock-manager.js";
import { MetricsRegistry } from "./metrics.js";
import { SessionTracker } from "./session-tracker.js";
import { StateManager } from "./state.js";

const execFileAsync = promisify(execFile);

// --- Protocol types ---

export interface DaemonRequest {
  id: string;
  method: string;
  params?: unknown;
}

export interface DaemonResponse {
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface DaemonStatus {
  pid: number;
  uptime: number; // ms
  sessions: number;
  locks: number;
  fuses: number;
}

export interface DaemonStartOpts {
  metricsPort?: number;
  configDir?: string;
  adapters?: Record<string, AgentAdapter>;
}

const startTime = Date.now();

export async function startDaemon(opts: DaemonStartOpts = {}): Promise<{
  socketServer: net.Server;
  httpServer: http.Server;
  shutdown: () => Promise<void>;
}> {
  const configDir = opts.configDir || path.join(os.homedir(), ".agentctl");
  await fs.mkdir(configDir, { recursive: true });

  const pidFilePath = path.join(configDir, "agentctl.pid");
  const sockPath = path.join(configDir, "agentctl.sock");

  // 1. Kill stale daemon/supervisor processes before anything else (#39)
  await killStaleDaemons(configDir);

  // 2. Verify no daemon is actually running by trying to connect to socket
  const socketAlive = await isSocketAlive(sockPath);
  if (socketAlive) {
    throw new Error("Daemon already running (socket responsive)");
  }

  // 3. Clean stale socket file
  await fs.rm(sockPath, { force: true });

  // 4. Save shell environment for subprocess spawning (#42)
  await saveEnvironment(configDir);

  // 5. Clear binary cache on restart (#41 — pick up moved/updated binaries)
  clearBinaryCache();

  // 6. Run migration (idempotent)
  await migrateLocks(configDir).catch((err) =>
    console.error("Migration warning:", err.message),
  );

  // 7. Load persisted state
  const state = await StateManager.load(configDir);

  // 8. Initialize subsystems
  const adapters: Record<string, AgentAdapter> = opts.adapters || {
    "claude-code": new ClaudeCodeAdapter(),
    codex: new CodexAdapter(),
    openclaw: new OpenClawAdapter(),
    opencode: new OpenCodeAdapter(),
    pi: new PiAdapter(),
    "pi-rust": new PiRustAdapter(),
  };

  const lockManager = new LockManager(state);
  const emitter = new EventEmitter();
  const fuseEngine = new FuseEngine(state, {
    defaultDurationMs: 10 * 60 * 1000,
    emitter,
  });
  const sessionTracker = new SessionTracker(state, { adapters });
  const metrics = new MetricsRegistry(sessionTracker, lockManager, fuseEngine);

  // Wire up events
  emitter.on("fuse.fired", () => {
    metrics.recordFuseFired();
  });

  // 9. Validate all sessions on startup — mark dead ones as stopped (#40)
  sessionTracker.validateAllSessions();

  // 10. Resume fuse timers
  fuseEngine.resumeTimers();

  // 11. Start session polling
  sessionTracker.startPolling();

  // 12. Create request handler
  const handleRequest = createRequestHandler({
    sessionTracker,
    lockManager,
    fuseEngine,
    metrics,
    adapters,
    state,
    configDir,
    sockPath,
  });

  // 13. Start Unix socket server
  const socketServer = net.createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const req = JSON.parse(line) as DaemonRequest;
          handleRequest(req).then(
            (result) => {
              const resp: DaemonResponse = { id: req.id, result };
              conn.write(`${JSON.stringify(resp)}\n`);
            },
            (err) => {
              const resp: DaemonResponse = {
                id: req.id,
                error: {
                  code: "ERR",
                  message: (err as Error).message,
                },
              };
              conn.write(`${JSON.stringify(resp)}\n`);
            },
          );
        } catch {
          // Malformed JSON — ignore
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    socketServer.listen(sockPath, () => resolve());
    socketServer.on("error", reject);
  });

  // 14. Write PID file (after socket is listening — acts as "lock acquired")
  await fs.writeFile(pidFilePath, String(process.pid));

  // 15. Start HTTP metrics server
  const metricsPort = opts.metricsPort ?? 9200;
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/metrics" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4",
      });
      res.end(metrics.generateMetrics());
    } else {
      res.writeHead(404);
      res.end("Not Found\n");
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(metricsPort, "127.0.0.1", () => resolve());
    httpServer.on("error", reject);
  });

  // Shutdown function
  const shutdown = async () => {
    sessionTracker.stopPolling();
    fuseEngine.shutdown();
    state.flush();
    await state.persist();
    socketServer.close();
    httpServer.close();
    await fs.rm(sockPath, { force: true });
    await fs.rm(pidFilePath, { force: true });
  };

  // 16. Signal handlers
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, async () => {
      console.log(`Received ${sig}, shutting down...`);
      await shutdown();
      process.exit(0);
    });
  }

  console.log(`agentctl daemon started (PID ${process.pid})`);
  console.log(`  Socket: ${sockPath}`);
  console.log(`  Metrics: http://localhost:${metricsPort}/metrics`);

  return { socketServer, httpServer, shutdown };
}

// --- Stale daemon cleanup (#39) ---

/**
 * Find and kill ALL stale agentctl daemon/supervisor processes.
 * This ensures singleton enforcement even after unclean shutdowns.
 */
async function killStaleDaemons(configDir: string): Promise<void> {
  // 1. Kill processes recorded in PID files
  for (const pidFile of ["agentctl.pid", "supervisor.pid"]) {
    const p = path.join(configDir, pidFile);
    const pid = await readPidFile(p);
    if (pid && pid !== process.pid && isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        // Wait briefly for clean shutdown
        await sleep(500);
        if (isProcessAlive(pid)) {
          process.kill(pid, "SIGKILL");
        }
      } catch {
        // Already gone
      }
    }
    // Clean up stale PID file
    await fs.rm(p, { force: true }).catch(() => {});
  }

  // 2. Scan ps for any remaining agentctl daemon processes
  try {
    const { stdout } = await execFileAsync("ps", ["aux"]);
    for (const line of stdout.split("\n")) {
      if (!line.includes("agentctl") || !line.includes("daemon")) continue;
      if (line.includes("grep")) continue;

      const fields = line.trim().split(/\s+/);
      if (fields.length < 2) continue;
      const pid = Number.parseInt(fields[1], 10);
      if (Number.isNaN(pid) || pid === process.pid) continue;
      // Also skip our parent process (supervisor)
      if (pid === process.ppid) continue;

      try {
        process.kill(pid, "SIGTERM");
        await sleep(200);
        if (isProcessAlive(pid)) {
          process.kill(pid, "SIGKILL");
        }
      } catch {
        // Already gone
      }
    }
  } catch {
    // ps failed — best effort
  }
}

/**
 * Check if a Unix socket is actually responsive (not just a stale file).
 */
async function isSocketAlive(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(sockPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);

    socket.on("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });

    socket.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

// --- Request handler ---

interface HandlerContext {
  sessionTracker: SessionTracker;
  lockManager: LockManager;
  fuseEngine: FuseEngine;
  metrics: MetricsRegistry;
  adapters: Record<string, AgentAdapter>;
  state: StateManager;
  configDir: string;
  sockPath: string;
}

function createRequestHandler(ctx: HandlerContext) {
  return async (req: DaemonRequest): Promise<unknown> => {
    const params = (req.params || {}) as Record<string, unknown>;

    switch (req.method) {
      case "session.list": {
        let sessions = ctx.sessionTracker.listSessions({
          status: params.status as string | undefined,
          all: params.all as boolean | undefined,
        });
        if (params.group) {
          sessions = sessions.filter((s) => s.group === params.group);
        }
        return sessions;
      }

      case "session.status": {
        const session = ctx.sessionTracker.getSession(params.id as string);
        if (!session) throw new Error(`Session not found: ${params.id}`);
        return session;
      }

      case "session.peek": {
        // Auto-detect adapter from tracked session, fall back to param or claude-code
        const tracked = ctx.sessionTracker.getSession(params.id as string);
        const adapterName =
          (params.adapter as string) || tracked?.adapter || "claude-code";
        const adapter = ctx.adapters[adapterName];
        if (!adapter) throw new Error(`Unknown adapter: ${adapterName}`);
        // Use the full session ID if we resolved it from the tracker
        const peekId = tracked?.id || (params.id as string);
        return adapter.peek(peekId, {
          lines: params.lines as number | undefined,
        });
      }

      case "session.launch": {
        const cwd = params.cwd as string;

        // Check locks
        const lock = ctx.lockManager.check(cwd);
        if (lock && !params.force) {
          if (lock.type === "manual") {
            throw new Error(
              `Directory locked by ${lock.lockedBy}: ${lock.reason}. Use --force to override.`,
            );
          }
          throw new Error(
            `Directory in use by session ${lock.sessionId?.slice(0, 8)}. Use --force to override.`,
          );
        }

        // Cancel any pending fuse
        if (cwd) {
          ctx.fuseEngine.cancelFuse(cwd);
        }

        // Launch via adapter
        const adapterName = (params.adapter as string) || "claude-code";
        const adapter = ctx.adapters[adapterName];
        if (!adapter) throw new Error(`Unknown adapter: ${adapterName}`);

        const session = await adapter.launch({
          adapter: adapterName,
          prompt: params.prompt as string,
          cwd,
          spec: params.spec as string | undefined,
          model: params.model as string | undefined,
          env: params.env as Record<string, string> | undefined,
          adapterOpts: params.adapterOpts as
            | Record<string, unknown>
            | undefined,
        });

        // Propagate group tag if provided
        if (params.group) {
          session.group = params.group as string;
        }

        const record = ctx.sessionTracker.track(session, adapterName);

        // Auto-lock
        if (cwd) {
          ctx.lockManager.autoLock(cwd, session.id);
        }

        return record;
      }

      case "session.stop": {
        const session = ctx.sessionTracker.getSession(params.id as string);
        if (!session) throw new Error(`Session not found: ${params.id}`);

        // Ghost pending entry with dead PID: remove from state with --force
        if (
          session.id.startsWith("pending-") &&
          params.force &&
          session.pid &&
          !isProcessAlive(session.pid)
        ) {
          ctx.lockManager.autoUnlock(session.id);
          ctx.sessionTracker.removeSession(session.id);
          return null;
        }

        const adapter = ctx.adapters[session.adapter];
        if (!adapter) throw new Error(`Unknown adapter: ${session.adapter}`);
        await adapter.stop(session.id, {
          force: params.force as boolean | undefined,
        });

        // Remove auto-lock
        ctx.lockManager.autoUnlock(session.id);

        // Mark stopped and start fuse if applicable
        const stopped = ctx.sessionTracker.onSessionExit(session.id);
        if (stopped) {
          ctx.fuseEngine.onSessionExit(stopped);
          ctx.metrics.recordSessionStopped();
        }

        return null;
      }

      case "session.resume": {
        const session = ctx.sessionTracker.getSession(params.id as string);
        if (!session) throw new Error(`Session not found: ${params.id}`);
        const adapter = ctx.adapters[session.adapter];
        if (!adapter) throw new Error(`Unknown adapter: ${session.adapter}`);
        await adapter.resume(session.id, params.message as string);
        return null;
      }

      // --- Prune command (#40) ---
      case "session.prune": {
        const pruned = ctx.sessionTracker.pruneDeadSessions();
        return { pruned };
      }

      case "lock.list":
        return ctx.lockManager.listAll();

      case "lock.acquire":
        return ctx.lockManager.manualLock(
          params.directory as string,
          params.by as string | undefined,
          params.reason as string | undefined,
        );

      case "lock.release":
        ctx.lockManager.manualUnlock(params.directory as string);
        return null;

      case "fuse.list":
        return ctx.fuseEngine.listActive();

      case "fuse.cancel":
        ctx.fuseEngine.cancelFuse(params.directory as string);
        return null;

      case "daemon.status":
        return {
          pid: process.pid,
          uptime: Date.now() - startTime,
          sessions: ctx.sessionTracker.activeCount(),
          locks: ctx.lockManager.listAll().length,
          fuses: ctx.fuseEngine.listActive().length,
        } satisfies DaemonStatus;

      case "daemon.shutdown":
        // Graceful shutdown — defer so response can be sent first
        setTimeout(async () => {
          await ctx.state.persist();
          process.exit(0);
        }, 100);
        return null;

      default:
        throw new Error(`Unknown method: ${req.method}`);
    }
  };
}

// --- Helpers ---

async function readPidFile(pidFilePath: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(pidFilePath, "utf-8");
    return Number.parseInt(raw.trim(), 10);
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
