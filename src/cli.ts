#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../package.json");

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { CodexAdapter } from "./adapters/codex.js";
import { OpenClawAdapter } from "./adapters/openclaw.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import { PiAdapter } from "./adapters/pi.js";
import { PiRustAdapter } from "./adapters/pi-rust.js";
import { DaemonClient } from "./client/daemon-client.js";
import type {
  AgentAdapter,
  AgentSession,
  LifecycleHooks,
  ListOpts,
} from "./core/types.js";
import type { DaemonStatus } from "./daemon/server.js";
import type { FuseTimer, Lock, SessionRecord } from "./daemon/state.js";
import { runHook } from "./hooks.js";
import {
  type AdapterSlot,
  orchestrateLaunch,
  parseAdapterSlots,
} from "./launch-orchestrator.js";
import { expandMatrix, parseMatrixFile } from "./matrix-parser.js";
import { mergeSession } from "./merge.js";
import { createWorktree, type WorktreeInfo } from "./worktree.js";

const adapters: Record<string, AgentAdapter> = {
  "claude-code": new ClaudeCodeAdapter(),
  codex: new CodexAdapter(),
  openclaw: new OpenClawAdapter(),
  opencode: new OpenCodeAdapter(),
  pi: new PiAdapter(),
  "pi-rust": new PiRustAdapter(),
};

const client = new DaemonClient();

/**
 * Ensure the daemon is running. Auto-starts it if not.
 * Returns true if daemon is available after the call.
 * Set AGENTCTL_NO_DAEMON=1 to skip daemon and use direct adapter mode.
 */
async function ensureDaemon(): Promise<boolean> {
  if (process.env.AGENTCTL_NO_DAEMON === "1") return false;
  if (await client.isRunning()) return true;

  // Auto-start daemon in background
  try {
    const __filename = fileURLToPath(import.meta.url);
    const logDir = path.join(os.homedir(), ".agentctl");
    await fs.mkdir(logDir, { recursive: true });

    const child = spawn(
      process.execPath,
      [__filename, "daemon", "start", "--supervised"],
      {
        detached: true,
        stdio: [
          "ignore",
          (await fs.open(path.join(logDir, "daemon.stdout.log"), "a")).fd,
          (await fs.open(path.join(logDir, "daemon.stderr.log"), "a")).fd,
        ],
      },
    );
    child.unref();

    // Wait briefly for daemon to be ready (up to 3s)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (await client.isRunning()) return true;
    }
  } catch {
    // Failed to auto-start — fall through to direct mode
  }
  return false;
}

function getAdapter(name?: string): AgentAdapter {
  if (!name) {
    return adapters["claude-code"];
  }
  const adapter = adapters[name];
  if (!adapter) {
    console.error(`Unknown adapter: ${name}`);
    process.exit(1);
  }
  return adapter;
}

function getAllAdapters(): AgentAdapter[] {
  return Object.values(adapters);
}

// --- Formatters ---

function formatSession(
  s: AgentSession,
  showGroup: boolean,
): Record<string, string> {
  const row: Record<string, string> = {
    ID: s.id.slice(0, 8),
    Status: s.status,
    Model: s.model || "-",
  };
  if (showGroup) row.Group = s.group || "-";
  row.CWD = s.cwd ? shortenPath(s.cwd) : "-";
  row.PID = s.pid?.toString() || "-";
  row.Started = timeAgo(s.startedAt);
  row.Prompt = (s.prompt || "-").slice(0, 60);
  return row;
}

function formatRecord(
  s: SessionRecord,
  showGroup: boolean,
): Record<string, string> {
  const row: Record<string, string> = {
    ID: s.id.slice(0, 8),
    Status: s.status,
    Model: s.model || "-",
  };
  if (showGroup) row.Group = s.group || "-";
  row.CWD = s.cwd ? shortenPath(s.cwd) : "-";
  row.PID = s.pid?.toString() || "-";
  row.Started = timeAgo(new Date(s.startedAt));
  row.Prompt = (s.prompt || "-").slice(0, 60);
  return row;
}

function shortenPath(p: string): string {
  const home = process.env.HOME || "";
  if (p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 0) return "expired";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function printTable(rows: Record<string, string>[]): void {
  if (rows.length === 0) {
    console.log("No sessions found.");
    return;
  }

  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => (r[k] || "").length)),
  );

  const header = keys.map((k, i) => k.padEnd(widths[i])).join("  ");
  console.log(header);
  console.log(widths.map((w) => "-".repeat(w)).join("  "));

  for (const row of rows) {
    const line = keys
      .map((k, i) => (row[k] || "").padEnd(widths[i]))
      .join("  ");
    console.log(line);
  }
}

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function sessionToJson(s: AgentSession): Record<string, unknown> {
  return {
    id: s.id,
    adapter: s.adapter,
    status: s.status,
    startedAt: s.startedAt.toISOString(),
    stoppedAt: s.stoppedAt?.toISOString(),
    cwd: s.cwd,
    model: s.model,
    prompt: s.prompt,
    tokens: s.tokens,
    cost: s.cost,
    pid: s.pid,
    group: s.group,
    meta: s.meta,
  };
}

// --- CLI ---

const program = new Command();

program
  .name("agentctl")
  .description("Universal agent supervision interface")
  .version(PKG_VERSION);

// list
program
  .command("list")
  .description("List agent sessions")
  .option("--adapter <name>", "Filter by adapter")
  .option("--status <status>", "Filter by status (running|stopped|idle|error)")
  .option("--group <id>", "Filter by launch group (e.g. g-a1b2c3)")
  .option("-a, --all", "Include stopped sessions (last 7 days)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const daemonRunning = await ensureDaemon();

    if (daemonRunning) {
      let sessions = await client.call<SessionRecord[]>("session.list", {
        status: opts.status,
        all: opts.all,
        adapter: opts.adapter,
        group: opts.group,
      });
      if (opts.adapter) {
        sessions = sessions.filter((s) => s.adapter === opts.adapter);
      }
      if (opts.json) {
        printJson(sessions);
      } else {
        const hasGroups = sessions.some((s) => s.group);
        printTable(sessions.map((s) => formatRecord(s, hasGroups)));
      }
      return;
    }

    // Direct fallback
    const listOpts: ListOpts = { status: opts.status, all: opts.all };
    let sessions: AgentSession[] = [];

    if (opts.adapter) {
      const adapter = getAdapter(opts.adapter);
      sessions = await adapter.list(listOpts);
    } else {
      for (const adapter of getAllAdapters()) {
        const s = await adapter.list(listOpts);
        sessions.push(...s);
      }
    }

    if (opts.json) {
      printJson(sessions.map(sessionToJson));
    } else {
      const hasGroups = sessions.some((s) => s.group);
      printTable(sessions.map((s) => formatSession(s, hasGroups)));
    }
  });

// status
program
  .command("status <id>")
  .description("Show detailed session status")
  .option("--adapter <name>", "Adapter to use")
  .option("--json", "Output as JSON")
  .action(async (id: string, opts) => {
    const daemonRunning = await ensureDaemon();

    if (daemonRunning) {
      try {
        const session = await client.call<SessionRecord>("session.status", {
          id,
        });
        if (opts.json) {
          printJson(session);
        } else {
          const fmt = formatRecord(session, !!session.group);
          for (const [k, v] of Object.entries(fmt)) {
            console.log(`${k.padEnd(10)} ${v}`);
          }
          if (session.tokens) {
            console.log(
              `Tokens     in: ${session.tokens.in}, out: ${session.tokens.out}`,
            );
          }
        }
        return;
      } catch {
        // Daemon failed — fall through to direct adapter lookup
      }
    }

    // Direct fallback: try specified adapter, or search all adapters
    const statusAdapters = opts.adapter
      ? [getAdapter(opts.adapter)]
      : getAllAdapters();

    for (const adapter of statusAdapters) {
      try {
        const session = await adapter.status(id);
        if (opts.json) {
          printJson(sessionToJson(session));
        } else {
          const fmt = formatSession(session, !!session.group);
          for (const [k, v] of Object.entries(fmt)) {
            console.log(`${k.padEnd(10)} ${v}`);
          }
          if (session.tokens) {
            console.log(
              `Tokens     in: ${session.tokens.in}, out: ${session.tokens.out}`,
            );
          }
        }
        return;
      } catch {
        // Try next adapter
      }
    }
    console.error(`Session not found: ${id}`);
    process.exit(1);
  });

// peek
program
  .command("peek <id>")
  .description("Peek at recent output from a session")
  .option("-n, --lines <n>", "Number of recent messages", "20")
  .option("--adapter <name>", "Adapter to use")
  .action(async (id: string, opts) => {
    const daemonRunning = await ensureDaemon();

    if (daemonRunning) {
      try {
        const output = await client.call<string>("session.peek", {
          id,
          lines: Number.parseInt(opts.lines, 10),
        });
        console.log(output);
        return;
      } catch {
        // Daemon failed — fall through to direct adapter lookup
      }
    }

    // Direct fallback: try specified adapter, or search all adapters
    if (opts.adapter) {
      const adapter = getAdapter(opts.adapter);
      try {
        const output = await adapter.peek(id, {
          lines: Number.parseInt(opts.lines, 10),
        });
        console.log(output);
        return;
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    }

    for (const adapter of getAllAdapters()) {
      try {
        const output = await adapter.peek(id, {
          lines: Number.parseInt(opts.lines, 10),
        });
        console.log(output);
        return;
      } catch {
        // Try next adapter
      }
    }
    console.error(`Session not found: ${id}`);
    process.exit(1);
  });

// stop
program
  .command("stop <id>")
  .description("Stop a running session")
  .option("--force", "Force kill (SIGINT then SIGKILL)")
  .option("--adapter <name>", "Adapter to use")
  .action(async (id: string, opts) => {
    const daemonRunning = await ensureDaemon();

    if (daemonRunning) {
      try {
        await client.call("session.stop", {
          id,
          force: opts.force,
        });
        console.log(`Stopped session ${id.slice(0, 8)}`);
        return;
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    }

    const adapter = getAdapter(opts.adapter);
    try {
      await adapter.stop(id, { force: opts.force });
      console.log(`Stopped session ${id.slice(0, 8)}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// resume
program
  .command("resume <id> <message>")
  .description("Resume a session with a new message")
  .option("--adapter <name>", "Adapter to use")
  .action(async (id: string, message: string, opts) => {
    const daemonRunning = await ensureDaemon();

    if (daemonRunning) {
      try {
        await client.call("session.resume", { id, message });
        console.log(`Resumed session ${id.slice(0, 8)}`);
        return;
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    }

    const adapter = getAdapter(opts.adapter);
    try {
      await adapter.resume(id, message);
      console.log(`Resumed session ${id.slice(0, 8)}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// launch
program
  .command("launch [adapter]")
  .description("Launch a new agent session (or multiple with --adapter flags)")
  .requiredOption("-p, --prompt <text>", "Prompt to send")
  .option("--spec <path>", "Spec file path")
  .option("--cwd <dir>", "Working directory")
  .option("--model <model>", "Model to use (e.g. sonnet, opus)")
  .option("--force", "Override directory locks")
  .option(
    "--worktree <repo>",
    "Auto-create git worktree from this repo before launch",
  )
  .option("--branch <name>", "Branch name for --worktree")
  .option(
    "--adapter <name>",
    "Adapter to launch (repeatable for parallel launch)",
    collectAdapter,
    [] as string[],
  )
  .option("--matrix <file>", "YAML matrix file for advanced sweep launch")
  .option("--on-create <script>", "Hook: run after session is created")
  .option("--on-complete <script>", "Hook: run after session completes")
  .option("--pre-merge <script>", "Hook: run before merge")
  .option("--post-merge <script>", "Hook: run after merge")
  .allowUnknownOption() // Allow interleaved --adapter/--model for parseAdapterSlots
  .action(async (adapterName: string | undefined, opts) => {
    let cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();

    // Collect hooks
    const hooks: LifecycleHooks | undefined =
      opts.onCreate || opts.onComplete || opts.preMerge || opts.postMerge
        ? {
            onCreate: opts.onCreate,
            onComplete: opts.onComplete,
            preMerge: opts.preMerge,
            postMerge: opts.postMerge,
          }
        : undefined;

    // --- Multi-adapter / matrix detection ---
    let slots: AdapterSlot[] = [];

    if (opts.matrix) {
      // Matrix file mode
      try {
        const matrixFile = await parseMatrixFile(opts.matrix);
        slots = expandMatrix(matrixFile);
        // Matrix can override cwd and prompt
        if (matrixFile.cwd) cwd = path.resolve(matrixFile.cwd);
      } catch (err) {
        console.error(`Failed to parse matrix file: ${(err as Error).message}`);
        process.exit(1);
      }
    } else {
      // Check for multi-adapter via raw argv parsing
      // We need raw argv because commander can't handle interleaved
      // --adapter A --model M1 --adapter B --model M2
      const rawArgs = process.argv.slice(2);
      const adapterCount = rawArgs.filter(
        (a) => a === "--adapter" || a === "-A",
      ).length;

      if (adapterCount > 1) {
        // Multi-adapter mode: parse from raw args
        slots = parseAdapterSlots(rawArgs);
      } else if (adapterCount === 1 && opts.adapter?.length === 1) {
        // Single --adapter flag — could still be multi if model is specified
        // but this is the normal single-adapter path via --adapter flag
      }
    }

    // --- Parallel launch path ---
    if (slots.length > 1) {
      const daemonRunning = await ensureDaemon();

      try {
        let groupId = "";
        const result = await orchestrateLaunch({
          slots,
          prompt: opts.prompt,
          spec: opts.spec,
          cwd,
          hooks,
          adapters,
          onSessionLaunched: (slotResult) => {
            // Track in daemon if available
            if (daemonRunning && !slotResult.error) {
              client
                .call("session.launch.track", {
                  id: slotResult.sessionId,
                  adapter: slotResult.slot.adapter,
                  cwd: slotResult.cwd,
                  group: groupId,
                })
                .catch(() => {
                  // Best effort — session will be picked up by poll
                });
            }
          },
          onGroupCreated: (id) => {
            groupId = id;
          },
        });

        console.log(
          `\nLaunched ${result.results.length} sessions (group: ${result.groupId}):`,
        );
        for (const r of result.results) {
          const label = r.slot.model
            ? `${r.slot.adapter} (${r.slot.model})`
            : r.slot.adapter;
          if (r.error) {
            console.log(`  ✗ ${label} — ${r.error}`);
          } else {
            console.log(
              `  ${label}  → ${shortenPath(r.cwd)}  (${r.sessionId.slice(0, 8)})`,
            );
          }
        }
      } catch (err) {
        console.error(`Parallel launch failed: ${(err as Error).message}`);
        process.exit(1);
      }
      return;
    }

    // --- Single adapter launch path (original behavior) ---
    const name =
      slots.length === 1 ? slots[0].adapter : adapterName || "claude-code";
    const model =
      slots.length === 1 && slots[0].model ? slots[0].model : opts.model;

    // FEAT-1: Worktree lifecycle
    let worktreeInfo: WorktreeInfo | undefined;
    if (opts.worktree) {
      if (!opts.branch) {
        console.error("--branch is required when using --worktree");
        process.exit(1);
      }
      try {
        worktreeInfo = await createWorktree({
          repo: opts.worktree,
          branch: opts.branch,
        });
        cwd = worktreeInfo.path;
        console.log(`Worktree created: ${worktreeInfo.path}`);
      } catch (err) {
        console.error(`Failed to create worktree: ${(err as Error).message}`);
        process.exit(1);
      }
    }

    const daemonRunning = await ensureDaemon();

    if (daemonRunning) {
      try {
        const session = await client.call<SessionRecord>("session.launch", {
          adapter: name,
          prompt: opts.prompt,
          cwd,
          spec: opts.spec,
          model,
          force: opts.force,
          worktree: worktreeInfo
            ? { repo: worktreeInfo.repo, branch: worktreeInfo.branch }
            : undefined,
          hooks,
        });
        console.log(
          `Launched session ${session.id.slice(0, 8)} (PID: ${session.pid})`,
        );

        // Run onCreate hook
        if (hooks?.onCreate) {
          await runHook(hooks, "onCreate", {
            sessionId: session.id,
            cwd,
            adapter: name,
            branch: opts.branch,
          });
        }

        return;
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    }

    // Direct fallback
    if (!opts.force) {
      console.error(
        "Warning: Daemon not running, launching without lock protection",
      );
    }
    const adapter = getAdapter(name);
    try {
      const session = await adapter.launch({
        adapter: name,
        prompt: opts.prompt,
        spec: opts.spec,
        cwd,
        model,
        hooks,
      });
      console.log(
        `Launched session ${session.id.slice(0, 8)} (PID: ${session.pid})`,
      );

      // Run onCreate hook
      if (hooks?.onCreate) {
        await runHook(hooks, "onCreate", {
          sessionId: session.id,
          cwd,
          adapter: name,
          branch: opts.branch,
        });
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

/** Commander collect callback for repeatable --adapter */
function collectAdapter(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

// events
program
  .command("events")
  .description("Stream lifecycle events")
  .option("--json", "Output as NDJSON (default)")
  .action(async () => {
    const adapter = getAdapter("claude-code");
    for await (const event of adapter.events()) {
      const out = {
        type: event.type,
        adapter: event.adapter,
        sessionId: event.sessionId,
        timestamp: event.timestamp.toISOString(),
        session: sessionToJson(event.session),
        meta: event.meta,
      };
      console.log(JSON.stringify(out));
    }
  });

// --- Merge command (FEAT-4) ---

program
  .command("merge <id>")
  .description("Commit, push, and open PR for a session's work")
  .option("-m, --message <text>", "Commit message")
  .option("--remove-worktree", "Remove worktree after merge")
  .option("--repo <path>", "Main repo path (for worktree removal)")
  .option("--pre-merge <script>", "Hook: run before merge")
  .option("--post-merge <script>", "Hook: run after merge")
  .action(async (id: string, opts) => {
    // Find session
    const daemonRunning = await ensureDaemon();
    let sessionCwd: string | undefined;
    let sessionAdapter: string | undefined;

    if (daemonRunning) {
      try {
        const session = await client.call<SessionRecord>("session.status", {
          id,
        });
        sessionCwd = session.cwd;
        sessionAdapter = session.adapter;
      } catch {
        // Fall through to adapter
      }
    }

    if (!sessionCwd) {
      const adapter = getAdapter();
      try {
        const session = await adapter.status(id);
        sessionCwd = session.cwd;
        sessionAdapter = session.adapter;
      } catch (err) {
        console.error(`Session not found: ${(err as Error).message}`);
        process.exit(1);
      }
    }

    if (!sessionCwd) {
      console.error("Cannot determine session working directory");
      process.exit(1);
    }

    const hooks: LifecycleHooks | undefined =
      opts.preMerge || opts.postMerge
        ? { preMerge: opts.preMerge, postMerge: opts.postMerge }
        : undefined;

    // Pre-merge hook
    if (hooks?.preMerge) {
      await runHook(hooks, "preMerge", {
        sessionId: id,
        cwd: sessionCwd,
        adapter: sessionAdapter || "claude-code",
      });
    }

    const result = await mergeSession({
      cwd: sessionCwd,
      message: opts.message,
      removeWorktree: opts.removeWorktree,
      repoPath: opts.repo,
    });

    if (result.committed) console.log("Changes committed");
    if (result.pushed) console.log("Pushed to remote");
    if (result.prUrl) console.log(`PR: ${result.prUrl}`);
    if (result.worktreeRemoved) console.log("Worktree removed");

    if (!result.committed && !result.pushed) {
      console.log("No changes to commit or push");
    }

    // Post-merge hook
    if (hooks?.postMerge) {
      await runHook(hooks, "postMerge", {
        sessionId: id,
        cwd: sessionCwd,
        adapter: sessionAdapter || "claude-code",
      });
    }
  });

// --- Worktree subcommand ---

const worktreeCmd = new Command("worktree").description(
  "Manage agentctl-created worktrees",
);

worktreeCmd
  .command("list")
  .description("List git worktrees for a repo")
  .argument("<repo>", "Path to the main repo")
  .option("--json", "Output as JSON")
  .action(async (repo: string, opts) => {
    const { listWorktrees } = await import("./worktree.js");

    try {
      const entries = await listWorktrees(repo);
      // Filter to only non-bare worktrees (exclude the main worktree)
      const worktrees = entries.filter((e) => !e.bare);

      if (opts.json) {
        printJson(worktrees);
        return;
      }

      if (worktrees.length === 0) {
        console.log("No worktrees found.");
        return;
      }

      printTable(
        worktrees.map((e) => ({
          Path: shortenPath(e.path),
          Branch: e.branch || "-",
          HEAD: e.head?.slice(0, 8) || "-",
        })),
      );
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

worktreeCmd
  .command("clean")
  .description("Remove a worktree and optionally its branch")
  .argument("<path>", "Path to the worktree to remove")
  .option("--repo <path>", "Main repo path (auto-detected if omitted)")
  .option("--delete-branch", "Also delete the worktree's branch")
  .action(async (worktreePath: string, opts) => {
    const { cleanWorktree } = await import("./worktree.js");

    const absPath = path.resolve(worktreePath);
    let repo = opts.repo;

    // Auto-detect repo from the worktree's .git file
    if (!repo) {
      try {
        const gitFile = await fs.readFile(path.join(absPath, ".git"), "utf-8");
        // .git file contains: gitdir: /path/to/repo/.git/worktrees/<name>
        const match = gitFile.match(/gitdir:\s*(.+)/);
        if (match) {
          const gitDir = match[1].trim();
          // Navigate up from .git/worktrees/<name> to the repo root
          repo = path.resolve(gitDir, "..", "..", "..");
        }
      } catch {
        console.error(
          "Cannot auto-detect repo. Use --repo to specify the main repository.",
        );
        process.exit(1);
      }
    }

    if (!repo) {
      console.error("Cannot determine repo path. Use --repo.");
      process.exit(1);
    }

    try {
      const result = await cleanWorktree(repo, absPath, {
        deleteBranch: opts.deleteBranch,
      });
      console.log(`Removed worktree: ${shortenPath(result.removedPath)}`);
      if (result.deletedBranch) {
        console.log(`Deleted branch: ${result.deletedBranch}`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program.addCommand(worktreeCmd);

// --- Lock commands ---

program
  .command("lock <directory>")
  .description("Manually lock a directory")
  .option("--by <name>", "Who is locking", os.userInfo().username)
  .option("--reason <reason>", "Why")
  .action(async (directory: string, opts) => {
    const absDir = path.resolve(directory);
    try {
      await client.call<Lock>("lock.acquire", {
        directory: absDir,
        by: opts.by,
        reason: opts.reason,
      });
      console.log(`Locked: ${absDir}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("unlock <directory>")
  .description("Unlock a manually locked directory")
  .action(async (directory: string) => {
    const absDir = path.resolve(directory);
    try {
      await client.call("lock.release", { directory: absDir });
      console.log(`Unlocked: ${absDir}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("locks")
  .description("List all directory locks")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      const locks = await client.call<Lock[]>("lock.list");
      if (opts.json) {
        printJson(locks);
        return;
      }
      if (locks.length === 0) {
        console.log("No active locks");
        return;
      }
      printTable(
        locks.map((l) => ({
          Directory: shortenPath(l.directory),
          Type: l.type,
          "Locked By": l.lockedBy || l.sessionId?.slice(0, 8) || "-",
          Reason: l.reason || "-",
          Since: timeAgo(new Date(l.lockedAt)),
        })),
      );
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// --- Fuses command ---

program
  .command("fuses")
  .description("List active Kind cluster fuse timers")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      const fuses = await client.call<FuseTimer[]>("fuse.list");
      if (opts.json) {
        printJson(fuses);
        return;
      }
      if (fuses.length === 0) {
        console.log("No active fuses");
        return;
      }
      printTable(
        fuses.map((f) => ({
          Directory: shortenPath(f.directory),
          Cluster: f.clusterName,
          "Expires In": formatDuration(
            new Date(f.expiresAt).getTime() - Date.now(),
          ),
        })),
      );
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// --- Prune command (#40) ---

program
  .command("prune")
  .description("Remove dead and stale sessions from daemon state")
  .action(async () => {
    const daemonRunning = await ensureDaemon();
    if (!daemonRunning) {
      console.error("Daemon not running. Start with: agentctl daemon start");
      process.exit(1);
    }
    try {
      const result = await client.call<{ pruned: number }>("session.prune");
      console.log(`Pruned ${result.pruned} dead/stale sessions`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// --- Daemon subcommand ---

const daemonCmd = new Command("daemon").description(
  "Manage the agentctl daemon",
);

daemonCmd
  .command("start")
  .description("Start the daemon")
  .option("--foreground", "Run in foreground (don't daemonize)")
  .option("--supervised", "Run under supervisor (auto-restart on crash)")
  .option("--metrics-port <port>", "Prometheus metrics port", "9200")
  .action(async (opts) => {
    if (opts.foreground) {
      // Foreground mode — import and start directly
      const { startDaemon } = await import("./daemon/server.js");
      await startDaemon({
        metricsPort: Number(opts.metricsPort),
      });
      return;
    }

    if (opts.supervised) {
      // Supervised mode — run supervisor loop in foreground (launched detached)
      const { runSupervisor } = await import("./daemon/supervisor.js");
      const __filename = fileURLToPath(import.meta.url);
      await runSupervisor({
        nodePath: process.execPath,
        cliPath: __filename,
        metricsPort: Number(opts.metricsPort),
        configDir: path.join(os.homedir(), ".agentctl"),
      });
      return;
    }

    // Default: launch supervisor in background (detached)
    const __filename = fileURLToPath(import.meta.url);
    const logDir = path.join(os.homedir(), ".agentctl");
    await fs.mkdir(logDir, { recursive: true });

    const child = spawn(
      process.execPath,
      [
        __filename,
        "daemon",
        "start",
        "--supervised",
        "--metrics-port",
        opts.metricsPort,
      ],
      {
        detached: true,
        stdio: [
          "ignore",
          (await fs.open(path.join(logDir, "daemon.stdout.log"), "a")).fd,
          (await fs.open(path.join(logDir, "daemon.stderr.log"), "a")).fd,
        ],
      },
    );
    child.unref();
    console.log(`Daemon started with supervisor (PID ${child.pid})`);
  });

daemonCmd
  .command("stop")
  .description("Stop the daemon")
  .action(async () => {
    // Stop supervisor first (prevents auto-restart)
    const { getSupervisorPid } = await import("./daemon/supervisor.js");
    const supPid = await getSupervisorPid();
    if (supPid) {
      try {
        process.kill(supPid, "SIGTERM");
      } catch {
        // Already gone
      }
    }
    try {
      await client.call("daemon.shutdown");
      console.log("Daemon stopped");
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

daemonCmd
  .command("status")
  .description("Show daemon status and all daemon-related processes")
  .action(async () => {
    // Show daemon status
    try {
      const status = await client.call<DaemonStatus>("daemon.status");
      console.log(`Daemon running (PID ${status.pid})`);
      console.log(`  Uptime: ${formatDuration(status.uptime)}`);
      console.log(`  Active sessions: ${status.sessions}`);
      console.log(`  Active locks: ${status.locks}`);
      console.log(`  Active fuses: ${status.fuses}`);
    } catch {
      console.log("Daemon not running");
    }

    // Show all daemon-related processes (#39)
    const configDir = path.join(os.homedir(), ".agentctl");
    const { getSupervisorPid } = await import("./daemon/supervisor.js");
    const supPid = await getSupervisorPid();

    let daemonPid: number | null = null;
    try {
      const raw = await fs.readFile(
        path.join(configDir, "agentctl.pid"),
        "utf-8",
      );
      const pid = Number.parseInt(raw.trim(), 10);
      try {
        process.kill(pid, 0);
        daemonPid = pid;
      } catch {
        // PID file is stale
      }
    } catch {
      // No PID file
    }

    console.log("\nDaemon-related processes:");
    if (supPid) {
      console.log(`  Supervisor: PID ${supPid} (alive)`);
    } else {
      console.log("  Supervisor: not running");
    }
    if (daemonPid) {
      console.log(`  Daemon: PID ${daemonPid} (alive)`);
    } else {
      console.log("  Daemon: not running");
    }
  });

daemonCmd
  .command("restart")
  .description("Restart the daemon")
  .action(async () => {
    try {
      await client.call("daemon.shutdown");
    } catch {
      // Daemon wasn't running — that's fine
    }
    // Also kill supervisor if running
    const { getSupervisorPid } = await import("./daemon/supervisor.js");
    const supPid = await getSupervisorPid();
    if (supPid) {
      try {
        process.kill(supPid, "SIGTERM");
      } catch {
        // Already gone
      }
    }
    // Wait for old processes to exit
    await new Promise((r) => setTimeout(r, 500));
    // Start new daemon with supervisor
    const __filename = fileURLToPath(import.meta.url);
    const logDir = path.join(os.homedir(), ".agentctl");
    await fs.mkdir(logDir, { recursive: true });
    const child = spawn(
      process.execPath,
      [__filename, "daemon", "start", "--supervised"],
      {
        detached: true,
        stdio: [
          "ignore",
          (await fs.open(path.join(logDir, "daemon.stdout.log"), "a")).fd,
          (await fs.open(path.join(logDir, "daemon.stderr.log"), "a")).fd,
        ],
      },
    );
    child.unref();
    console.log(`Daemon restarted with supervisor (PID ${child.pid})`);
  });

daemonCmd
  .command("install")
  .description("Install LaunchAgent (auto-start on login)")
  .action(async () => {
    const { generatePlist } = await import("./daemon/launchagent.js");
    const plistPath = path.join(
      os.homedir(),
      "Library/LaunchAgents/com.agentctl.daemon.plist",
    );
    const plistContent = generatePlist();
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.writeFile(plistPath, plistContent);
    const { execSync } = await import("node:child_process");
    execSync(`launchctl load ${plistPath}`);
    console.log("LaunchAgent installed. Daemon will start on login.");
  });

daemonCmd
  .command("uninstall")
  .description("Remove LaunchAgent")
  .action(async () => {
    const plistPath = path.join(
      os.homedir(),
      "Library/LaunchAgents/com.agentctl.daemon.plist",
    );
    const { execSync } = await import("node:child_process");
    try {
      execSync(`launchctl unload ${plistPath}`);
    } catch {
      // Already unloaded
    }
    await fs.rm(plistPath, { force: true });
    console.log("LaunchAgent removed.");
  });

program.addCommand(daemonCmd);

program.parse();
