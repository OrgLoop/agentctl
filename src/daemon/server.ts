import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { OpenClawAdapter } from "../adapters/openclaw.js";
import type { AgentAdapter } from "../core/types.js";
import { migrateLocks } from "../migration/migrate-locks.js";
import { FuseEngine } from "./fuse-engine.js";
import { LockManager } from "./lock-manager.js";
import { MetricsRegistry } from "./metrics.js";
import { SessionTracker } from "./session-tracker.js";
import { StateManager } from "./state.js";

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

  // 1. Check for existing daemon
  const pidFilePath = path.join(configDir, "agentctl.pid");
  const existingPid = await readPidFile(pidFilePath);
  if (existingPid && isProcessAlive(existingPid)) {
    throw new Error(`Daemon already running (PID ${existingPid})`);
  }

  // 2. Clean stale socket
  const sockPath = path.join(configDir, "agentctl.sock");
  await fs.rm(sockPath, { force: true });

  // 3. Run migration (idempotent)
  await migrateLocks(configDir).catch((err) =>
    console.error("Migration warning:", err.message),
  );

  // 4. Load persisted state
  const state = await StateManager.load(configDir);

  // 5. Initialize subsystems
  const adapters: Record<string, AgentAdapter> = opts.adapters || {
    "claude-code": new ClaudeCodeAdapter(),
    openclaw: new OpenClawAdapter(),
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

  // 6. Resume fuse timers
  fuseEngine.resumeTimers();

  // 7. Start session polling
  sessionTracker.startPolling();

  // 8. Create request handler
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

  // 9. Start Unix socket server
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

  // 10. Start HTTP metrics server
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

  // 11. Write PID file
  await fs.writeFile(pidFilePath, String(process.pid));

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

  // 12. Signal handlers
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
      case "session.list":
        return ctx.sessionTracker.listSessions({
          status: params.status as string | undefined,
          all: params.all as boolean | undefined,
        });

      case "session.status": {
        const session = ctx.sessionTracker.getSession(params.id as string);
        if (!session) throw new Error(`Session not found: ${params.id}`);
        return session;
      }

      case "session.peek": {
        const adapterName = (params.adapter as string) || "claude-code";
        const adapter = ctx.adapters[adapterName];
        if (!adapter) throw new Error(`Unknown adapter: ${adapterName}`);
        return adapter.peek(params.id as string, {
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
