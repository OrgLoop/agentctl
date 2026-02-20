# agentctl

Universal agent supervision interface. Monitor and control AI coding agents from a single CLI.

agentctl reads from native sources (Claude Code's `~/.claude/` directory, running processes) and provides a standard interface to list, inspect, stop, launch, and resume agent sessions. It never replicates state — it reads what's actually happening.

## Layer Model

| Layer | Role |
|-------|------|
| **agentctl** | Read/control interface. Discovers sessions, emits lifecycle events. |
| **OrgLoop** | Routes lifecycle events to mechanical reactions (cluster fuse, notifications). |
| **OpenClaw** | Reasoning layer. Makes judgment calls about what to do. |

agentctl intentionally does **not**:
- Maintain its own session registry (reads native sources)
- Have a hook/reaction system (that's OrgLoop)
- Make judgment calls about what to do (that's OpenClaw)

## Why agentctl?

You can use `claude code` (or any agent CLI) directly — agentctl is not a replacement. It's a supervisory layer for people and agents managing multiple concurrent coding sessions.

What it adds: session discovery across all running Claude Code instances, lifecycle tracking that persists session info even after processes exit, a daemon with directory locks to prevent duplicate launches on the same working directory, fuse timers for automated resource cleanup, and a standard interface that works the same regardless of which coding agent is underneath. The adapter model means support for additional agent runtimes (Codex, Aider, etc.) can be added without changing the CLI or daemon interface.

Over time, agentctl can extend to handle more concerns of headless coding — automating worktree bootstrap/teardown, running N parallel implementations across different adapters and models and judging who did it best, and other patterns that emerge as AI-assisted development matures.

## Installation

```bash
npm install -g agentctl
```

Requires Node.js >= 20.

## Quick Start

```bash
# List running sessions
agentctl list

# List all sessions (including stopped, last 7 days)
agentctl list -a

# Peek at recent output from a session
agentctl peek <session-id>

# Launch a new Claude Code session
agentctl launch -p "Read the spec and implement phase 2"

# Stop a session
agentctl stop <session-id>

# Resume a stopped session with a new message
agentctl resume <session-id> "fix the failing tests"
```

Session IDs support prefix matching — `agentctl peek abc123` matches any session starting with `abc123`.

## CLI Reference

### Session Management

```bash
agentctl list [options]
  --adapter <name>     Filter by adapter (claude-code, openclaw)
  --status <status>    Filter by status (running|stopped|idle|error)
  -a, --all            Include stopped sessions (last 7 days)
  --json               Output as JSON

agentctl status <id> [options]
  --adapter <name>     Adapter to use
  --json               Output as JSON

agentctl peek <id> [options]
  -n, --lines <n>      Number of recent messages (default: 20)
  --adapter <name>     Adapter to use

agentctl launch [adapter] [options]
  -p, --prompt <text>  Prompt to send (required)
  --spec <path>        Spec file path
  --cwd <dir>          Working directory
  --model <model>      Model to use (e.g. sonnet, opus)
  --force              Override directory locks

agentctl stop <id> [options]
  --force              Force kill (SIGINT then SIGKILL)
  --adapter <name>     Adapter to use

agentctl resume <id> <message> [options]
  --adapter <name>     Adapter to use

agentctl events [options]
  --json               Output as NDJSON (default)
```

### Directory Locks

agentctl tracks which directories have active sessions to prevent conflicting launches.

```bash
agentctl lock <directory> [options]
  --by <name>          Who is locking
  --reason <reason>    Why

agentctl unlock <directory>

agentctl locks [options]
  --json               Output as JSON
```

### Fuse Timers

For Kind cluster management — automatically shuts down clusters when sessions end.

```bash
agentctl fuses [options]
  --json               Output as JSON
```

### Daemon

The daemon provides session tracking, directory locks, fuse timers, and Prometheus metrics. It auto-starts on first `agentctl` command.

```bash
agentctl daemon start [options]
  --foreground         Run in foreground (don't daemonize)
  --metrics-port       Prometheus metrics port (default: 9200)

agentctl daemon stop
agentctl daemon status
agentctl daemon restart

agentctl daemon install    # Install macOS LaunchAgent (auto-start on login)
agentctl daemon uninstall  # Remove LaunchAgent
```

Metrics are exposed at `http://localhost:9200/metrics` in Prometheus text format.

## Architecture

agentctl is structured in three layers: the **CLI** parses commands and formats output, the **daemon** provides persistent state (session tracking, directory locks, fuse timers, Prometheus metrics), and **adapters** bridge to specific agent runtimes. The CLI communicates with the daemon over a Unix socket at `~/.agentctl/agentctl.sock`.

All session state is derived from native sources — agentctl never maintains its own session registry. The Claude Code adapter reads `~/.claude/projects/` and cross-references running processes; other adapters connect to their respective APIs. This means agentctl always reflects ground truth.

## Adapters

agentctl uses an adapter model to support different agent runtimes.

### Claude Code (default)

Reads session data from `~/.claude/projects/` and cross-references with running `claude` processes. Detects PID recycling via process start time verification. Tracks detached processes that survive wrapper exit.

### OpenClaw

Connects to the OpenClaw gateway via WebSocket RPC. Read-only — sessions are managed through the gateway.

### Writing an Adapter

Implement the `AgentAdapter` interface:

```typescript
interface AgentAdapter {
  id: string;
  list(opts?: ListOpts): Promise<AgentSession[]>;
  peek(sessionId: string, opts?: PeekOpts): Promise<string>;
  status(sessionId: string): Promise<AgentSession>;
  launch(opts: LaunchOpts): Promise<AgentSession>;
  stop(sessionId: string, opts?: StopOpts): Promise<void>;
  resume(sessionId: string, message: string): Promise<void>;
  events(): AsyncIterable<LifecycleEvent>;
}
```

## Configuration

agentctl stores daemon state in `~/.agentctl/`:

```
~/.agentctl/
  agentctl.sock          # Unix socket for CLI ↔ daemon communication
  agentctl.pid           # Daemon PID file
  state.json             # Session tracking state
  locks.json             # Directory locks
  fuses.json             # Fuse timers
  daemon.stdout.log      # Daemon stdout
  daemon.stderr.log      # Daemon stderr
```

## Development

```bash
git clone https://github.com/c-h-/agentctl.git
cd agentctl
npm install
npm run build
npm link              # makes agentctl available globally
```

```bash
npm run dev           # run CLI via tsx (no build needed)
npm test              # vitest
npm run typecheck     # tsc --noEmit
npm run lint          # biome check
```

### Project Structure

```
src/
  cli.ts                         # CLI entry point (commander)
  core/types.ts                  # Core interfaces
  adapters/claude-code.ts        # Claude Code adapter
  adapters/openclaw.ts           # OpenClaw gateway adapter
  daemon/server.ts               # Daemon: Unix socket server + HTTP metrics
  daemon/session-tracker.ts      # Session lifecycle tracking
  daemon/lock-manager.ts         # Directory locks
  daemon/fuse-engine.ts          # Kind cluster fuse timers
  daemon/metrics.ts              # Prometheus metrics registry
  daemon/state.ts                # State persistence
  daemon/launchagent.ts          # macOS LaunchAgent plist generator
  client/daemon-client.ts        # Unix socket client
  migration/migrate-locks.ts     # Migration from legacy locks
```

## License

MIT
