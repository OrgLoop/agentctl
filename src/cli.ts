#!/usr/bin/env node

import { Command } from "commander";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { OpenClawAdapter } from "./adapters/openclaw.js";
import type { AgentAdapter, AgentSession, ListOpts } from "./core/types.js";

const adapters: Record<string, AgentAdapter> = {
  "claude-code": new ClaudeCodeAdapter(),
  openclaw: new OpenClawAdapter(),
};

function getAdapter(name?: string): AgentAdapter {
  if (!name) {
    // Default to claude-code (only adapter for now)
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

function formatSession(s: AgentSession): Record<string, string> {
  return {
    ID: s.id.slice(0, 8),
    Status: s.status,
    Model: s.model || "-",
    CWD: s.cwd ? shortenPath(s.cwd) : "-",
    PID: s.pid?.toString() || "-",
    Started: timeAgo(s.startedAt),
    Prompt: (s.prompt || "-").slice(0, 60),
  };
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

function printTable(rows: Record<string, string>[]): void {
  if (rows.length === 0) {
    console.log("No sessions found.");
    return;
  }

  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => (r[k] || "").length)),
  );

  // Header
  const header = keys.map((k, i) => k.padEnd(widths[i])).join("  ");
  console.log(header);
  console.log(widths.map((w) => "-".repeat(w)).join("  "));

  // Rows
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
    meta: s.meta,
  };
}

// --- CLI ---

const program = new Command();

program
  .name("agent-ctl")
  .description("Universal agent supervision interface")
  .version("0.1.0");

// list
program
  .command("list")
  .description("List agent sessions")
  .option("--adapter <name>", "Filter by adapter")
  .option("--status <status>", "Filter by status (running|stopped|idle|error)")
  .option("-a, --all", "Include stopped sessions (last 7 days)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const listOpts: ListOpts = {
      status: opts.status,
      all: opts.all,
    };

    let sessions: AgentSession[] = [];

    if (opts.adapter) {
      const adapter = getAdapter(opts.adapter);
      sessions = await adapter.list(listOpts);
    } else {
      // All adapters
      for (const adapter of getAllAdapters()) {
        const s = await adapter.list(listOpts);
        sessions.push(...s);
      }
    }

    if (opts.json) {
      printJson(sessions.map(sessionToJson));
    } else {
      printTable(sessions.map(formatSession));
    }
  });

// status
program
  .command("status <id>")
  .description("Show detailed session status")
  .option("--adapter <name>", "Adapter to use")
  .option("--json", "Output as JSON")
  .action(async (id: string, opts) => {
    const adapter = getAdapter(opts.adapter);
    try {
      const session = await adapter.status(id);
      if (opts.json) {
        printJson(sessionToJson(session));
      } else {
        const fmt = formatSession(session);
        for (const [k, v] of Object.entries(fmt)) {
          console.log(`${k.padEnd(10)} ${v}`);
        }
        if (session.tokens) {
          console.log(
            `Tokens     in: ${session.tokens.in}, out: ${session.tokens.out}`,
          );
        }
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// peek
program
  .command("peek <id>")
  .description("Peek at recent output from a session")
  .option("-n, --lines <n>", "Number of recent messages", "20")
  .option("--adapter <name>", "Adapter to use")
  .action(async (id: string, opts) => {
    const adapter = getAdapter(opts.adapter);
    try {
      const output = await adapter.peek(id, {
        lines: parseInt(opts.lines, 10),
      });
      console.log(output);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// stop
program
  .command("stop <id>")
  .description("Stop a running session")
  .option("--force", "Force kill (SIGINT then SIGKILL)")
  .option("--adapter <name>", "Adapter to use")
  .action(async (id: string, opts) => {
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
  .command("launch <adapter>")
  .description("Launch a new agent session")
  .requiredOption("-p, --prompt <text>", "Prompt to send")
  .option("--spec <path>", "Spec file path")
  .option("--cwd <dir>", "Working directory")
  .option("--model <model>", "Model to use (e.g. sonnet, opus)")
  .action(async (adapterName: string, opts) => {
    const adapter = getAdapter(adapterName);
    try {
      const session = await adapter.launch({
        adapter: adapterName,
        prompt: opts.prompt,
        spec: opts.spec,
        cwd: opts.cwd,
        model: opts.model,
      });
      console.log(
        `Launched session ${session.id.slice(0, 8)} (PID: ${session.pid})`,
      );
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

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

program.parse();
