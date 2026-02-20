import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface SupervisorOpts {
  /** Path to Node.js executable */
  nodePath: string;
  /** Path to the CLI entry point */
  cliPath: string;
  /** Metrics port */
  metricsPort: number;
  /** Config directory (~/.agentctl) */
  configDir: string;
  /** Minimum backoff delay in ms (default: 1000) */
  minBackoffMs?: number;
  /** Maximum backoff delay in ms (default: 300000 = 5min) */
  maxBackoffMs?: number;
  /** Reset backoff after this many ms of uptime (default: 60000 = 1min) */
  stableUptimeMs?: number;
}

/**
 * Daemon supervisor — launches the daemon in foreground mode and
 * restarts it on crash with exponential backoff (1s, 2s, 4s... cap 5min).
 * Resets backoff after stable uptime.
 */
export async function runSupervisor(opts: SupervisorOpts): Promise<void> {
  const minBackoff = opts.minBackoffMs ?? 1000;
  const maxBackoff = opts.maxBackoffMs ?? 300_000;
  const stableUptime = opts.stableUptimeMs ?? 60_000;

  let currentBackoff = minBackoff;
  let running = true;

  // Write supervisor PID file
  const supervisorPidPath = path.join(opts.configDir, "supervisor.pid");
  await fs.writeFile(supervisorPidPath, String(process.pid));

  const cleanup = async () => {
    running = false;
    await fs.rm(supervisorPidPath, { force: true }).catch(() => {});
  };

  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });

  const logDir = opts.configDir;
  await fs.mkdir(logDir, { recursive: true });

  while (running) {
    const startTime = Date.now();

    const stdoutFd = await fs.open(path.join(logDir, "daemon.stdout.log"), "a");
    const stderrFd = await fs.open(path.join(logDir, "daemon.stderr.log"), "a");

    const child = spawn(
      opts.nodePath,
      [
        opts.cliPath,
        "daemon",
        "start",
        "--foreground",
        "--metrics-port",
        String(opts.metricsPort),
      ],
      {
        stdio: ["ignore", stdoutFd.fd, stderrFd.fd],
      },
    );

    // Wait for child to exit
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.on("error", () => resolve(1));
    });

    await stdoutFd.close();
    await stderrFd.close();

    if (!running) break;

    const uptime = Date.now() - startTime;

    // Reset backoff if daemon ran long enough to be considered stable
    if (uptime >= stableUptime) {
      currentBackoff = minBackoff;
    }

    console.error(
      `Daemon exited (code ${exitCode}) after ${Math.round(uptime / 1000)}s. Restarting in ${Math.round(currentBackoff / 1000)}s...`,
    );

    await new Promise((r) => setTimeout(r, currentBackoff));

    // Exponential backoff (double, capped)
    currentBackoff = Math.min(currentBackoff * 2, maxBackoff);
  }
}

/** Read the supervisor PID from disk and check if it's alive */
export async function getSupervisorPid(
  configDir?: string,
): Promise<number | null> {
  const dir = configDir || path.join(os.homedir(), ".agentctl");
  try {
    const raw = await fs.readFile(path.join(dir, "supervisor.pid"), "utf-8");
    const pid = Number.parseInt(raw.trim(), 10);
    process.kill(pid, 0); // Check liveness
    return pid;
  } catch {
    return null;
  }
}
