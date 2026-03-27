# agentctl

Universal interface for supervising coding agents. Launch, monitor, resume, interrupt, and compare sessions across adapters from one CLI.

agentctl reads from native sources (Claude Code's `~/.claude/` directory, Pi's `~/.pi/` directory, running processes) and provides a standard control plane to list, inspect, stop, launch, and resume agent sessions. It never replicates state — it reads what's actually happening.

## Design Philosophy

agentctl intentionally does **not** maintain its own session registry — it reads native agent sources and cross-references running processes. The daemon tracks only launch metadata, directory locks, and fuse timers. This keeps agentctl grounded in what is actually running, not a shadow copy that drifts out of date.

agentctl provides lightweight operational hooks (lifecycle hooks, webhooks) for reacting to session events, but leaves higher-level judgment — what to do about a failed run, whether to retry, how to route work — to systems above it.

## Why agentctl?

You can use `claude code` (or any agent CLI) directly — agentctl is not a replacement. It's the supervision layer you reach for once you're running enough agent sessions that you need one interface to operate them reliably.

The practical value is simple: launch work, see what's running, resume interrupted sessions, stop the ones that went sideways, and compare outcomes across adapters without learning a different control surface for each one. That operator UX matters whether the supervisor is a human juggling multiple sessions or another agent coordinating work on your behalf.

What it adds today: session discovery across running agents, lifecycle tracking that persists session info even after processes exit, a daemon with directory locks to prevent duplicate launches on the same working directory, fuse timers for automated resource cleanup, webhooks for external integrations, and a standard interface that works the same regardless of which coding agent is underneath. The adapter model means support for additional agent runtimes can be added without changing the CLI or daemon interface.

The bigger idea is modest but useful: agentctl is a universal control plane for coding agents. It focuses on the operational layer — launch, monitor, resume, interrupt, compare — while leaving native execution to each adapter and higher-level judgment to systems above it.

## Positioning

agentctl is for the operational layer of AI coding work.

- **Universal interface**: one CLI across Claude Code, Codex, OpenCode, Pi, and other adapters
- **Supervision surface**: inspect live work, resume stalled sessions, interrupt bad runs, and monitor progress
- **Comparison workflow**: run the same task across adapters or models in isolated worktrees
- **Ground-truth state**: read native agent sources instead of maintaining a parallel registry

It is intentionally not the reasoning layer and not the event router. agentctl is the control plane; other systems can decide what should happen and react to the events it emits.

## Installation

```bash
npm install -g @orgloop/agentctl
```

Requires Node.js >= 20.

Public adapters currently shipped in the CLI: `claude-code`, `codex`, `opencode`, `pi`, `pi-rust`, and `openclaw`.
ACP-backed adapter work is in progress internally, but adapters such as `codex-acp` are not user-visible until packaging and discover-first session reattachment are ready.

## Quick Start

```bash
# List running sessions
agentctl list

# List all sessions (including stopped, last 7 days)
agentctl list -a

# Peek at recent output from a session (alias: logs)
agentctl peek <session-id>
agentctl logs <session-id>

# Launch a new Claude Code session
agentctl launch -p "Read the spec and implement phase 2"

# Launch in a specific directory
agentctl launch -p "Fix the auth bug" --cwd ~/code/mono

# Launch with context files
agentctl launch -p "Implement the feature" --file spec.md --file examples.ts

# Launch a new Pi session
agentctl launch pi -p "Refactor the auth module"

# Stop a session
agentctl stop <session-id>

# Resume a stopped session with a new message
agentctl resume <session-id> "fix the failing tests"
```

Session IDs support prefix matching — `agentctl peek abc123` (or `agentctl logs abc123`) matches any session starting with `abc123`.

### Parallel Multi-Adapter Launch

Launch the same prompt across multiple adapters (or the same adapter with different models). Each gets its own git worktree and runs in isolation, which makes side-by-side comparison a normal workflow instead of a special-case experiment:

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
  --adapter <name>     Filter by adapter (claude-code, codex, codex-acp, opencode, pi, pi-rust, openclaw)
  --status <status>    Filter by status (running|stopped|idle|error)
  --group <id>         Filter by launch group (e.g. g-a1b2c3)
  -a, --all            Include stopped sessions (last 7 days)
  --json               Output as JSON

agentctl status <id> [options]
  --adapter <name>     Adapter to use
  --json               Output as JSON

agentctl peek <id> [options]
  -n, --lines <n>      Number of recent messages (default: 20)
  --adapter <name>     Adapter to use

agentctl logs <id> [options]
  -n, --lines <n>      Number of recent messages (default: 50)
  --adapter <name>     Adapter to use

agentctl launch [adapter] [options]
  -p, --prompt <text>  Prompt to send (required)
  --spec <path>        Spec file path
  --file <path>        File to include in context (repeatable)
  --max-file-size <b>  Max file size in bytes (default: 51200)
  --cwd <dir>          Working directory (default: current directory)
  --model <model>      Model to use (e.g. sonnet, opus)
  --adapter <name>     Adapter to launch (repeatable for parallel launch)
  --matrix <file>      YAML matrix file for advanced sweep launch
  --worktree <repo>    Auto-create git worktree for isolation
  --branch <name>      Branch name for worktree
  --on-create <script> Hook: run after session created
  --on-complete <script> Hook: run after session completes
  --callback-session <key>  Callback session key for orchestration
  --callback-agent <id>     Callback agent ID for orchestration
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

agentctl prune
# Remove dead/stale sessions from daemon state

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

Hooks are shell commands that run at specific points in a session's lifecycle. They let you make sessions operationally complete — bootstrap the environment before launch, then test or notify the moment work finishes. Pass them as flags to `launch`:

```bash
agentctl launch -p "implement feature X" \
  --on-create "echo 'Session $AGENTCTL_SESSION_ID started'" \
  --on-complete "npm test"
```

Available hooks:

| Hook | Trigger | Typical use |
|------|---------|-------------|
| `--on-create <script>` | After a session is created | Notify, set up environment |
| `--on-complete <script>` | After a session completes | Run tests, send alerts |

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

Hooks run with a 300-second (5-minute) timeout. If a hook fails, an error is thrown with the failure details.

### Webhooks

The daemon can POST a JSON payload to a configured URL whenever a session stops. Configure via environment variables or `~/.agentctl/config.json`:

| Source | Variable / Key |
|--------|---------------|
| Env var | `AGENTCTL_WEBHOOK_URL` |
| Env var | `AGENTCTL_WEBHOOK_SECRET` |
| Config  | `webhook_url` |
| Config  | `webhook_secret` |

Environment variables take precedence over config file values. When a secret is configured, the request includes HMAC-SHA256 signatures in the `X-Agentctl-Signature`, `X-Signature`, and `X-Hub-Signature-256` headers.

Payload shape:

```json
{
  "hook_type": "session.stopped",
  "session_id": "abc123...",
  "adapter": "claude-code",
  "duration_seconds": 340,
  "exit_status": 0,
  "summary": "Implement the caching layer...",
  "meta": {},
  "timestamp": "2026-03-01T12:00:00.000Z"
}
```

### Fuse Timers

Fuse timers are directory-scoped TTL timers with configurable on-expire actions. When set, a fuse starts a countdown for a given directory. If the timer expires, it can run a shell script, POST to a webhook, or emit a named event.

**How it works:**

1. A fuse is set for a directory with a TTL (default: 10 minutes)
2. Optionally, on-expire actions are configured (script, webhook, and/or event)
3. If the timer expires, the configured actions fire
4. If the fuse is extended or cancelled before expiry, actions don't fire

Fuse timers are generic and not tied to any specific infrastructure. Consumers decide what actions to take on expiry.

```bash
# List active fuse timers
agentctl fuses [options]
  --json               Output as JSON
```

Example output:

```
Directory                   Expires In
~/code/mono-feat-x          12m
~/code/mono-hotfix          45m
```

### Daemon

The daemon provides session tracking, directory locks, fuse timers, webhooks, and Prometheus metrics. It auto-starts on first `agentctl` command and runs under a supervisor that automatically restarts it on crash with exponential backoff.

Set `AGENTCTL_NO_DAEMON=1` to skip the daemon entirely and use direct adapter mode.

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
{"type":"session.started","adapter":"claude-code","sessionId":"abc123...","timestamp":"2026-03-01T10:30:00.000Z","session":{...}}
{"type":"session.stopped","adapter":"claude-code","sessionId":"abc123...","timestamp":"2026-03-01T11:00:00.000Z","session":{...}}
{"type":"session.idle","adapter":"claude-code","sessionId":"def456...","timestamp":"2026-03-01T11:05:00.000Z","session":{...}}
```

Event types: `session.started`, `session.stopped`, `session.idle`, `session.error`.

The `session` field contains the full session object (id, adapter, status, cwd, model, prompt, tokens, etc.).

**Piping events to external systems:**

```bash
# Pipe lifecycle events to a webhook endpoint
agentctl events | while IFS= read -r event; do
  curl -s -X POST https://example.com/hooks/agentctl \
    -H "Content-Type: application/json" \
    -d "$event"
done

# Or use a persistent pipe with jq filtering
agentctl events | jq -c 'select(.type == "session.stopped")' | while IFS= read -r event; do
  curl -s -X POST https://example.com/hooks/session-ended \
    -H "Content-Type: application/json" \
    -d "$event"
done
```

This pattern works with any webhook-based system — Zapier, n8n, or a custom event router. The NDJSON format is compatible with standard Unix tools (`jq`, `grep`, `awk`) for filtering and transformation.

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
| `agentctl_fuses_expired_total` | — | Total fuse timers that expired |

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

agentctl is structured in three layers: the **CLI** is the operator interface, the **daemon** provides persistent supervision state (launch metadata, directory locks, fuse timers, webhooks, Prometheus metrics), and **adapters** bridge to specific agent runtimes. The CLI communicates with the daemon over a Unix socket at `~/.agentctl/agentctl.sock`.

Session state is derived from native adapter sources — `session.list` fans out `discover()` to all adapters in parallel and merges the results with daemon-held launch metadata (prompts, groups, specs). The daemon tracks only what it launched; adapters are the source of truth for session lifecycle. This keeps agentctl grounded in what is actually running, not a shadow copy that drifts out of date.

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

### Pi Rust

Reads session data from `~/.pi/agent/sessions/` and cross-references with running `pi_agent_rust` processes. Same discovery pattern as the Pi adapter but targeting the Rust implementation.

### Codex ACP

Connects to Codex via the Agent Client Protocol (ACP) transport. Instead of PTY management and session-file scraping, this adapter delegates launch, resume, and lifecycle to ACP using the `@agentclientprotocol/sdk`. This is the first ACP-backed adapter and serves as a reference for migrating other adapters to ACP (see [ADR-001](docs/adr/adr-001-agentctl-adopts-acp.md)).

```bash
agentctl launch codex-acp -p "implement the feature"
```

### Generic ACP Adapter

The `src/adapters/acp/` directory provides a reusable ACP adapter that can back any ACP-compatible agent runtime. It includes:

- **AcpClient** — spawns an ACP-compatible agent binary, connects via stdio, and manages the JSON-RPC session
- **AcpAdapter** — implements the `AgentAdapter` interface on top of `AcpClient`, translating between ACP sessions and agentctl's session model

New agent runtimes with ACP bridges can be added with minimal configuration rather than writing a full bespoke adapter.

### OpenClaw

Connects to the OpenClaw gateway via WebSocket RPC. Read-only — sessions are managed through the gateway.

Requires the `OPENCLAW_WEBHOOK_TOKEN` environment variable. The adapter warns clearly if the token is missing or authentication fails.

### Writing an Adapter

Implement the `AgentAdapter` interface:

```typescript
interface AgentAdapter {
  id: string;
  discover(): Promise<DiscoveredSession[]>;
  isAlive(sessionId: string): Promise<boolean>;
  list(opts?: ListOpts): Promise<AgentSession[]>;
  peek(sessionId: string, opts?: PeekOpts): Promise<string>;
  status(sessionId: string): Promise<AgentSession>;
  launch(opts: LaunchOpts): Promise<AgentSession>;
  stop(sessionId: string, opts?: StopOpts): Promise<void>;
  resume(sessionId: string, message: string): Promise<void>;
  events(): AsyncIterable<LifecycleEvent>;
}
```

The key methods are `discover()` (ground-truth session state from the adapter's runtime) and `isAlive()` (lightweight liveness check). The `list()` method delegates to `discover()` with filtering.

## Configuration

agentctl stores daemon state in `~/.agentctl/`:

```
~/.agentctl/
  config.json            # Persistent config defaults (optional)
  agentctl.sock          # Unix socket for CLI ↔ daemon communication
  agentctl.pid           # Daemon PID file
  supervisor.pid         # Supervisor PID file
  state.json             # Launch metadata
  locks.json             # Directory locks
  fuses.json             # Fuse timers
  daemon.stdout.log      # Daemon stdout
  daemon.stderr.log      # Daemon stderr
```

### Config File

`~/.agentctl/config.json` provides persistent defaults that CLI flags override:

```json
{
  "adapter": "claude-code",
  "model": "claude-sonnet-4-5",
  "cwd": "~/code/mono",
  "webhook_url": "https://example.com/hooks/agentctl",
  "webhook_secret": "your-hmac-secret"
}
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
  core/types.ts                  # Core interfaces (AgentAdapter, DiscoveredSession, etc.)
  launch-orchestrator.ts         # Parallel multi-adapter launch orchestration
  matrix-parser.ts               # YAML matrix file parser + cross-product expansion
  worktree.ts                    # Git worktree create/list/clean
  hooks.ts                       # Lifecycle hook runner
  file-context.ts                # File context builder (--file/--spec)
  adapters/claude-code.ts        # Claude Code adapter
  adapters/codex.ts              # Codex CLI adapter
  adapters/codex-acp.ts          # Codex via ACP transport
  adapters/acp/acp-client.ts     # Generic ACP client
  adapters/acp/acp-adapter.ts    # Generic ACP-backed AgentAdapter
  adapters/openclaw.ts           # OpenClaw gateway adapter
  adapters/opencode.ts           # OpenCode adapter
  adapters/pi.ts                 # Pi coding agent adapter
  adapters/pi-rust.ts            # Pi Rust adapter
  daemon/server.ts               # Daemon: Unix socket server + HTTP metrics
  daemon/supervisor.ts           # Daemon supervisor (auto-restart on crash)
  daemon/session-tracker.ts      # Launch metadata tracking and reconciliation
  daemon/lock-manager.ts         # Auto + manual directory locks
  daemon/fuse-engine.ts          # Directory-scoped TTL fuse timers
  daemon/webhook.ts              # Webhook event emission
  daemon/metrics.ts              # Prometheus metrics registry
  daemon/state.ts                # State persistence
  daemon/launchagent.ts          # macOS LaunchAgent plist generator
  client/daemon-client.ts        # Unix socket client
  utils/config.ts                # Configuration loading
  utils/display.ts               # Display formatting utilities
  utils/resolve-binary.ts        # Binary path resolution
  utils/prompt-file.ts           # Prompt file handling (large prompts)
  utils/spawn-with-retry.ts      # Spawn with ENOENT retry
  migration/migrate-locks.ts     # Migration from legacy locks
```

## License

MIT
