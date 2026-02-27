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
  const metrics = new MetricsRegistry(lockManager, fuseEngine);

  // Wire up events
  emitter.on("fuse.expired", () => {
    metrics.recordFuseExpired();
  });

  // 9. Initial PID liveness cleanup for daemon-launched sessions
  //    (replaces the old validateAllSessions — much simpler, only checks launches)
  const initialDead = sessionTracker.cleanupDeadLaunches();
  if (initialDead.length > 0) {
    for (const id of initialDead) lockManager.autoUnlock(id);
    console.error(
      `Startup cleanup: marked ${initialDead.length} dead launches as stopped`,
    );
  }

  // 10. Resume fuse timers
  fuseEngine.resumeTimers();

  // 11. Start periodic PID liveness check for lock cleanup (30s interval)
  sessionTracker.startLaunchCleanup((deadId) => {
    lockManager.autoUnlock(deadId);
  });

  // 11b. Start periodic background resolution of pending-* session IDs (10s interval)
  sessionTracker.startPendingResolution((oldId, newId) => {
    lockManager.updateAutoLockSessionId(oldId, newId);
  });

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
    sessionTracker.stopLaunchCleanup();
    sessionTracker.stopPendingResolution();
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
        const adapterFilter = params.adapter as string | undefined;
        const statusFilter = params.status as string | undefined;
        const showAll = params.all as boolean | undefined;
        const groupFilter = params.group as string | undefined;

        // Fan out discover() to adapters (or just one if filtered)
        const adapterEntries = adapterFilter
          ? Object.entries(ctx.adapters).filter(
              ([name]) => name === adapterFilter,
            )
          : Object.entries(ctx.adapters);

        const ADAPTER_TIMEOUT_MS = Number.parseInt(
          process.env.AGENTCTL_ADAPTER_TIMEOUT ?? "5000",
          10,
        );
        const succeededAdapters = new Set<string>();
        const timedOutAdapters: string[] = [];

        const results = await Promise.allSettled(
          adapterEntries.map(([name, adapter]) =>
            Promise.race([
              adapter.discover().then((sessions) => {
                succeededAdapters.add(name);
                return sessions.map((s) => ({ ...s, adapter: name }));
              }),
              new Promise<never>((_, reject) =>
                setTimeout(() => {
                  timedOutAdapters.push(name);
                  reject(new Error(`Adapter ${name} timed out`));
                }, ADAPTER_TIMEOUT_MS),
              ),
            ]),
          ),
        );

        // Collect names of adapters that errored (not timeout)
        const failedAdapters: string[] = [];
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const name = adapterEntries[i][0];
          if (r.status === "rejected" && !timedOutAdapters.includes(name)) {
            failedAdapters.push(name);
          }
        }

        // Merge fulfilled results, skip failed adapters
        const discovered: import("../core/types.js").DiscoveredSession[] =
          results
            .filter(
              (
                r,
              ): r is PromiseFulfilledResult<
                import("../core/types.js").DiscoveredSession[]
              > => r.status === "fulfilled",
            )
            .flatMap((r) => r.value);

        // Reconcile with launch metadata and enrich
        const { sessions: allSessions, stoppedLaunchIds } =
          ctx.sessionTracker.reconcileAndEnrich(discovered, succeededAdapters);

        // Release locks for sessions that disappeared from adapter results
        for (const id of stoppedLaunchIds) {
          ctx.lockManager.autoUnlock(id);
        }

        // Apply filters
        let sessions = allSessions;
        if (statusFilter) {
          sessions = sessions.filter((s) => s.status === statusFilter);
        } else if (!showAll) {
          sessions = sessions.filter(
            (s) => s.status === "running" || s.status === "idle",
          );
        }

        if (groupFilter) {
          sessions = sessions.filter((s) => s.group === groupFilter);
        }

        // Sort: running first, then by most recent
        sessions.sort((a, b) => {
          if (a.status === "running" && b.status !== "running") return -1;
          if (b.status === "running" && a.status !== "running") return 1;
          return (
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
          );
        });

        // Update metrics gauge
        ctx.metrics.setActiveSessionCount(
          allSessions.filter(
            (s) => s.status === "running" || s.status === "idle",
          ).length,
        );

        // Build warnings for omitted adapters
        const warnings: string[] = [];
        if (timedOutAdapters.length > 0) {
          warnings.push(
            `Adapter(s) timed out after ${ADAPTER_TIMEOUT_MS}ms: ${timedOutAdapters.join(", ")}`,
          );
        }
        if (failedAdapters.length > 0) {
          warnings.push(`Adapter(s) failed: ${failedAdapters.join(", ")}`);
        }

        return { sessions, warnings };
      }

      case "session.status": {
        let id = params.id as string;

        // On-demand resolution: if pending-*, try to resolve first
        const trackedForResolve = ctx.sessionTracker.getSession(id);
        const resolveTarget = trackedForResolve?.id || id;
        if (resolveTarget.startsWith("pending-")) {
          const resolvedId =
            await ctx.sessionTracker.resolvePendingId(resolveTarget);
          if (resolvedId !== resolveTarget) {
            ctx.lockManager.updateAutoLockSessionId(resolveTarget, resolvedId);
            id = resolvedId;
          }
        }

        // Check launch metadata to determine adapter
        const launchRecord = ctx.sessionTracker.getSession(id);
        const adapterName = (params.adapter as string) || launchRecord?.adapter;

        // Determine which adapters to search
        const adaptersToSearch = adapterName
          ? Object.entries(ctx.adapters).filter(
              ([name]) => name === adapterName,
            )
          : Object.entries(ctx.adapters);

        // Search adapters for the session
        for (const [name, adapter] of adaptersToSearch) {
          try {
            const discovered = await adapter.discover();
            let match = discovered.find((d) => d.id === id);
            // Prefix match
            if (!match) {
              const prefixMatches = discovered.filter((d) =>
                d.id.startsWith(id),
              );
              if (prefixMatches.length === 1) match = prefixMatches[0];
            }
            if (match) {
              const meta = ctx.sessionTracker.getSession(match.id);
              return {
                id: match.id,
                adapter: name,
                status: match.status,
                startedAt:
                  match.startedAt?.toISOString() ?? new Date().toISOString(),
                stoppedAt: match.stoppedAt?.toISOString(),
                cwd: match.cwd ?? meta?.cwd,
                model: match.model ?? meta?.model,
                prompt: match.prompt ?? meta?.prompt,
                tokens: match.tokens,
                cost: match.cost,
                pid: match.pid,
                spec: meta?.spec,
                group: meta?.group,
                meta: match.nativeMetadata ?? meta?.meta ?? {},
              };
            }
          } catch {
            // Adapter failed — try next
          }
        }

        // Fall back to launch metadata if adapters didn't find it
        if (launchRecord) return launchRecord;
        throw new Error(`Session not found: ${id}`);
      }

      case "session.peek": {
        // Auto-detect adapter from tracked session, fall back to param or claude-code
        let tracked = ctx.sessionTracker.getSession(params.id as string);
        let peekId = tracked?.id || (params.id as string);

        // On-demand resolution: if pending-*, try to resolve before peeking
        if (peekId.startsWith("pending-")) {
          const resolvedId = await ctx.sessionTracker.resolvePendingId(peekId);
          if (resolvedId !== peekId) {
            ctx.lockManager.updateAutoLockSessionId(peekId, resolvedId);
            peekId = resolvedId;
            tracked = ctx.sessionTracker.getSession(resolvedId);
          }
        }

        const adapterName =
          (params.adapter as string) || tracked?.adapter || "claude-code";
        const adapter = ctx.adapters[adapterName];
        if (!adapter) throw new Error(`Unknown adapter: ${adapterName}`);
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
              `Directory locked by ${lock.lockedBy ?? "unknown"}${lock.reason ? `: ${lock.reason}` : ""}. Use --force to override.`,
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
        const id = params.id as string;
        let launchRecord = ctx.sessionTracker.getSession(id);
        let sessionId = launchRecord?.id || id;

        // On-demand resolution: if pending-*, try to resolve before stopping
        if (sessionId.startsWith("pending-")) {
          const resolvedId =
            await ctx.sessionTracker.resolvePendingId(sessionId);
          if (resolvedId !== sessionId) {
            ctx.lockManager.updateAutoLockSessionId(sessionId, resolvedId);
            sessionId = resolvedId;
            launchRecord = ctx.sessionTracker.getSession(resolvedId);
          }
        }

        // Ghost pending entry with dead PID: remove from state with --force
        if (
          sessionId.startsWith("pending-") &&
          params.force &&
          launchRecord?.pid &&
          !isProcessAlive(launchRecord.pid)
        ) {
          ctx.lockManager.autoUnlock(sessionId);
          ctx.sessionTracker.removeSession(sessionId);
          return null;
        }

        const adapterName = (params.adapter as string) || launchRecord?.adapter;
        if (!adapterName)
          throw new Error(
            `Session not found: ${id}. Specify --adapter to stop a non-daemon session.`,
          );

        const adapter = ctx.adapters[adapterName];
        if (!adapter) throw new Error(`Unknown adapter: ${adapterName}`);

        await adapter.stop(sessionId, {
          force: params.force as boolean | undefined,
        });

        // Remove auto-lock
        ctx.lockManager.autoUnlock(sessionId);

        // Mark stopped in launch metadata
        const stopped = ctx.sessionTracker.onSessionExit(sessionId);
        if (stopped) {
          ctx.metrics.recordSessionStopped();
        }

        return null;
      }

      case "session.resume": {
        const id = params.id as string;
        let launchRecord = ctx.sessionTracker.getSession(id);
        let resumeId = launchRecord?.id || id;

        // On-demand resolution: if pending-*, try to resolve before resuming
        if (resumeId.startsWith("pending-")) {
          const resolvedId =
            await ctx.sessionTracker.resolvePendingId(resumeId);
          if (resolvedId !== resumeId) {
            ctx.lockManager.updateAutoLockSessionId(resumeId, resolvedId);
            resumeId = resolvedId;
            launchRecord = ctx.sessionTracker.getSession(resolvedId);
          }
        }

        const adapterName = (params.adapter as string) || launchRecord?.adapter;
        if (!adapterName)
          throw new Error(
            `Session not found: ${id}. Specify --adapter to resume a non-daemon session.`,
          );
        const adapter = ctx.adapters[adapterName];
        if (!adapter) throw new Error(`Unknown adapter: ${adapterName}`);
        await adapter.resume(resumeId, params.message as string);
        return null;
      }

      // --- Prune command (#40) --- kept for CLI backward compat
      case "session.prune": {
        // In the stateless model, there's no session registry to prune.
        // Clean up dead launches (PID liveness check) as a best-effort action.
        const deadIds = ctx.sessionTracker.cleanupDeadLaunches();
        for (const id of deadIds) {
          ctx.lockManager.autoUnlock(id);
        }
        return { pruned: deadIds.length };
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

      case "fuse.set":
        ctx.fuseEngine.setFuse({
          directory: params.directory as string,
          sessionId: params.sessionId as string,
          ttlMs: params.ttlMs as number | undefined,
          onExpire: params.onExpire as
            | { script?: string; webhook?: string; event?: string }
            | undefined,
          label: params.label as string | undefined,
        });
        return null;

      case "fuse.extend": {
        const extended = ctx.fuseEngine.extendFuse(
          params.directory as string,
          params.ttlMs as number | undefined,
        );
        if (!extended)
          throw new Error(`No active fuse for directory: ${params.directory}`);
        return null;
      }

      case "fuse.cancel":
        ctx.fuseEngine.cancelFuse(params.directory as string);
        return null;

      case "daemon.status":
        return {
          pid: process.pid,
          uptime: Date.now() - startTime,
          sessions: ctx.metrics.activeSessionCount,
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
