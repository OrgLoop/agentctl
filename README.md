# agentctl

Universal agent supervision interface. Monitor and control AI coding agents from a single CLI.

agentctl reads from native sources (Claude Code's `~/.claude/` directory, Pi's `~/.pi/` directory, running processes) and provides a standard interface to list, inspect, stop, launch, and resume agent sessions. It never replicates state — it reads what's actually happening.

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
npm install -g @orgloop/agentctl
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

# Launch in a specific directory
agentctl launch -p "Fix the auth bug" --cwd ~/code/mono

# Launch a new Pi session
agentctl launch pi -p "Refactor the auth module"

# Stop a session
agentctl stop <session-id>

# Resume a stopped session with a new message
agentctl resume <session-id> "fix the failing tests"
```

Session IDs support prefix matching — `agentctl peek abc123` matches any session starting with `abc123`.

### Parallel Multi-Adapter Launch

Launch the same prompt across multiple adapters (or the same adapter with different models). Each gets its own git worktree and runs in isolation:

```bash
# Launch across 3 adapters
agentctl launch \
  --adapter claude-code \
  --adapter codex \
  --adapter pi \
  --cwd ~/code/mono \
  -p "Implement the caching layer"

# Launched 3 sessions (group: g-a1b2c3):
#   claude-code  → ~/code/mono-try-g-a1b2c3-cc
#   codex        → ~/code/mono-try-g-a1b2c3-codex
#   pi           → ~/code/mono-try-g-a1b2c3-pi
```

Same adapter with different models:

```bash
agentctl launch \
  --adapter claude-code --model claude-opus-4-6 \
  --adapter claude-code --model claude-sonnet-4-5 \
  --adapter codex \
  --cwd ~/code/mono \
  -p "Refactor the auth module"
```

Groups show up in `agentctl list` automatically:

```bash
agentctl list
# ID        Status   Model           Group      CWD                          Prompt
# f3a1...   running  opus-4-6        g-x1y2z3   ~/mono-try-g-x1y2z3-cc-opus  Refactor...
# 8b2c...   running  sonnet-4-5      g-x1y2z3   ~/mono-try-g-x1y2z3-cc-son   Refactor...
# c4d3...   done     gpt-5.2-codex   g-x1y2z3   ~/mono-try-g-x1y2z3-codex    Refactor...

# Filter by group
agentctl list --group g-x1y2z3
```

### Matrix Files

For advanced sweep configurations, use a YAML matrix file:

```yaml
# matrix.yaml
prompt: "Implement the caching layer"
cwd: ~/code/mono
matrix:
  - adapter: claude-code
    model:
      - claude-opus-4-6
      - claude-sonnet-4-5
  - adapter: codex
```

```bash
agentctl launch --matrix matrix.yaml
# Launches 3 sessions: claude-code×opus, claude-code×sonnet, codex
```

Array values in `model` are expanded via cross-product.

## CLI Reference

### Session Management

```bash
agentctl list [options]
  --adapter <name>     Filter by adapter (claude-code, codex, opencode, pi, pi-rust, openclaw)
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
  --cwd <dir>          Working directory (default: current directory)
  --model <model>      Model to use (e.g. sonnet, opus)
  --adapter <name>     Adapter to launch (repeatable for parallel launch)
  --matrix <file>      YAML matrix file for advanced sweep launch
  --group <id>         Filter by launch group (for list command)
  --force              Override directory locks

When `--cwd` is omitted, the agent launches in the current working directory (`$PWD`). This means you should either `cd` into the target project first or pass `--cwd` explicitly. Launching from an unrelated directory (e.g. `~`) will start the agent in the wrong place.

agentctl stop <id> [options]
  --force              Force kill (SIGINT then SIGKILL)
  --adapter <name>     Adapter to use

agentctl resume <id> <message> [options]
  --adapter <name>     Adapter to use

# <message> is a continuation prompt sent to the agent.
# The agent receives it as new user input and resumes work.
# Example: resume a stopped session with a follow-up instruction
agentctl resume abc123 "fix the failing tests and re-run the suite"

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

### Worktree Management

Manage git worktrees created by parallel launches or `--worktree` flag:

```bash
agentctl worktree list <repo>
  --json               Output as JSON

agentctl worktree clean <path> [options]
  --repo <path>        Main repo path (auto-detected if omitted)
  --delete-branch      Also delete the worktree's branch
```

Example:

```bash
# List all worktrees for a repo
agentctl worktree list ~/code/mono

# Clean up a worktree and its branch
agentctl worktree clean ~/code/mono-try-g-a1b2c3-cc --delete-branch
```

### Lifecycle Hooks

Hooks are shell commands that run at specific points in a session's lifecycle. Pass them as flags to `launch` or `merge`:

```bash
agentctl launch -p "implement feature X" \
  --on-create "echo 'Session $AGENTCTL_SESSION_ID started'" \
  --on-complete "npm test"

agentctl merge <id> \
  --pre-merge "npm run lint && npm test" \
  --post-merge "curl -X POST https://slack.example.com/webhook -d '{\"text\": \"PR merged\"}'"
```

Available hooks:

| Hook | Trigger | Typical use |
|------|---------|-------------|
| `--on-create <script>` | After a session is created | Notify, set up environment |
| `--on-complete <script>` | After a session completes | Run tests, send alerts |
| `--pre-merge <script>` | Before `agentctl merge` commits | Lint, test, validate |
| `--post-merge <script>` | After `agentctl merge` pushes/opens PR | Notify, trigger CI |

Hook scripts receive context via environment variables:

| Variable | Description |
|----------|-------------|
| `AGENTCTL_SESSION_ID` | Session UUID |
| `AGENTCTL_CWD` | Working directory of the session |
| `AGENTCTL_ADAPTER` | Adapter name (e.g. `claude-code`) |
| `AGENTCTL_BRANCH` | Git branch (when using `--worktree`) |
| `AGENTCTL_EXIT_CODE` | Process exit code (in `--on-complete`) |
| `AGENTCTL_GROUP` | Launch group ID (in parallel launches) |
| `AGENTCTL_MODEL` | Model name (when specified) |

Hooks run with a 60-second timeout. If a hook fails, its stderr is printed but execution continues.

### Fuse Timers

Fuse timers provide automatic cleanup of [Kind](https://kind.sigs.k8s.io/) Kubernetes clusters tied to coding sessions. When a session exits, agentctl starts a countdown timer. If no new session starts in the same worktree directory before the timer expires, the associated Kind cluster is deleted to free resources.

This is useful when running agents in worktree-per-branch workflows where each branch has its own Kind cluster (e.g. `kindo-charlie-<branch>`). Without fuse timers, forgotten clusters accumulate and waste resources.

**How it works:**

1. Agent session exits in a worktree directory (e.g. `~/code/mono-my-feature`)
2. agentctl derives the cluster name (`kindo-charlie-my-feature`) and starts a fuse timer
3. If the timer expires (default: configured at daemon startup), the cluster is deleted via `kind delete cluster`
4. If a new session starts in the same directory before expiry, the fuse is cancelled

```bash
# List active fuse timers
agentctl fuses [options]
  --json               Output as JSON
```

Example output:

```
Directory             Cluster                     Expires In
~/code/mono-feat-x    kindo-charlie-feat-x        12m
~/code/mono-hotfix    kindo-charlie-hotfix        45m
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

Metrics are exposed at `http://localhost:9200/metrics` in Prometheus text format. See [Prometheus Metrics](#prometheus-metrics) for the full list.

### Events

`agentctl events` streams session lifecycle events as NDJSON (newline-delimited JSON). Each line is a self-contained JSON object:

```json
{"type":"session.started","adapter":"claude-code","sessionId":"abc123...","timestamp":"2025-06-15T10:30:00.000Z","session":{...}}
{"type":"session.stopped","adapter":"claude-code","sessionId":"abc123...","timestamp":"2025-06-15T11:00:00.000Z","session":{...}}
{"type":"session.idle","adapter":"claude-code","sessionId":"def456...","timestamp":"2025-06-15T11:05:00.000Z","session":{...}}
```

Event types: `session.started`, `session.stopped`, `session.idle`, `session.error`.

The `session` field contains the full session object (id, adapter, status, cwd, model, prompt, tokens, etc.).

**Piping events into OrgLoop (or similar event routers):**

```bash
# Pipe lifecycle events to OrgLoop's webhook endpoint
agentctl events | while IFS= read -r event; do
  curl -s -X POST https://orgloop.example.com/hooks/agentctl \
    -H "Content-Type: application/json" \
    -d "$event"
done

# Or use a persistent pipe with jq filtering
agentctl events | jq -c 'select(.type == "session.stopped")' | while IFS= read -r event; do
  curl -s -X POST https://orgloop.example.com/hooks/session-ended \
    -H "Content-Type: application/json" \
    -d "$event"
done
```

This pattern works with any webhook-based system — OrgLoop, Zapier, n8n, or a custom event router. The NDJSON format is compatible with standard Unix tools (`jq`, `grep`, `awk`) for filtering and transformation.

## Prometheus Metrics

The daemon exposes metrics at `http://localhost:9200/metrics` in Prometheus text format. Default port is 9200, configurable via `--metrics-port`.

### Gauges

| Metric | Labels | Description |
|--------|--------|-------------|
| `agentctl_sessions_active` | — | Number of currently active sessions |
| `agentctl_locks_active` | `type="auto"\|"manual"` | Number of active directory locks by type |
| `agentctl_fuses_active` | — | Number of active fuse timers |

### Counters

| Metric | Labels | Description |
|--------|--------|-------------|
| `agentctl_sessions_total` | `status="completed"\|"failed"\|"stopped"` | Total sessions by final status |
| `agentctl_fuses_fired_total` | — | Total fuse timers that fired (clusters deleted) |
| `agentctl_kind_clusters_deleted_total` | — | Total Kind clusters deleted by fuse timers |

### Histogram

| Metric | Buckets (seconds) | Description |
|--------|-------------------|-------------|
| `agentctl_session_duration_seconds` | 60, 300, 600, 1800, 3600, 7200, +Inf | Session duration distribution |

Example scrape config for Prometheus:

```yaml
scrape_configs:
  - job_name: agentctl
    static_configs:
      - targets: ["localhost:9200"]
```

## Architecture

agentctl is structured in three layers: the **CLI** parses commands and formats output, the **daemon** provides persistent state (session tracking, directory locks, fuse timers, Prometheus metrics), and **adapters** bridge to specific agent runtimes. The CLI communicates with the daemon over a Unix socket at `~/.agentctl/agentctl.sock`.

All session state is derived from native sources — agentctl never maintains its own session registry. The Claude Code adapter reads `~/.claude/projects/` and cross-references running processes; the Pi adapter reads `~/.pi/agent/sessions/` JSONL files; other adapters connect to their respective APIs. This means agentctl always reflects ground truth.

## Adapters

agentctl uses an adapter model to support different agent runtimes.

### Claude Code (default)

Reads session data from `~/.claude/projects/` and cross-references with running `claude` processes. Detects PID recycling via process start time verification. Tracks detached processes that survive wrapper exit.

### Codex CLI

Reads session data from `~/.codex/sessions/` and cross-references with running `codex` processes. Supports `codex exec` non-interactive mode for launching headless sessions. Detects PID recycling via process start time verification, same as the Claude Code adapter.

```bash
# Launch a Codex session
agentctl launch codex -p "implement the feature"

# Launch with specific model
agentctl launch codex -p "fix the bug" --model gpt-5.2-codex
```

### OpenCode

Reads session data from `~/.local/share/opencode/storage/` and cross-references with running `opencode` processes. Supports headless execution via `opencode run`.

OpenCode stores sessions as individual JSON files organized by project hash (SHA1 of the working directory path):

- **Session files**: `storage/session/<projectHash>/<sessionId>.json` — session metadata (title, directory, timestamps, summary)
- **Message files**: `storage/message/<sessionId>/<messageId>.json` — individual messages with token counts, cost, and model info
- **Part files**: `storage/part/<messageId>/` — message content parts

The adapter detects PID recycling via process start time verification, tracks detached processes that survive wrapper exit, and supports prefix matching for session IDs.

Launch sessions with `agentctl launch opencode -p "your prompt"`.

### Pi

Reads session data from `~/.pi/agent/sessions/` and cross-references with running `pi` processes. Pi stores sessions as JSONL files organized by cwd slug — each file starts with a `type:'session'` header containing metadata (id, cwd, provider, modelId, thinkingLevel, version).

Detects PID recycling via process start time verification. Tracks detached processes that survive wrapper exit. Persists session metadata in `~/.pi/agentctl/sessions/` for status checks after the launching wrapper exits.

Launch uses Pi's print mode (`pi -p "prompt"`) for headless execution. Resume launches a new Pi session in the same working directory since Pi doesn't have a native `--continue` flag.

Requires the `pi` binary (npm: `@mariozechner/pi-coding-agent`) to be available on PATH.

### OpenClaw

Connects to the OpenClaw gateway via WebSocket RPC. Read-only — sessions are managed through the gateway.

Requires the `OPENCLAW_WEBHOOK_TOKEN` environment variable. The adapter warns clearly if the token is missing or authentication fails.

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
git clone https://github.com/orgloop/agentctl.git
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
  launch-orchestrator.ts         # Parallel multi-adapter launch orchestration
  matrix-parser.ts               # YAML matrix file parser + cross-product expansion
  worktree.ts                    # Git worktree create/list/clean
  hooks.ts                       # Lifecycle hook runner
  merge.ts                       # Git commit/push/PR for sessions
  adapters/claude-code.ts        # Claude Code adapter
  adapters/codex.ts              # Codex CLI adapter
  adapters/openclaw.ts           # OpenClaw gateway adapter
  adapters/opencode.ts           # OpenCode adapter
  adapters/pi.ts                 # Pi coding agent adapter
  adapters/pi-rust.ts            # Pi Rust adapter
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
