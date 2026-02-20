# agentctl — Universal Agent Supervision Interface

**Status:** 🟢 Phase 1 Complete, v0.3.0 preparing for public release
**Author:** Charlie Hulcher + Jarvis
**Date:** 2026-02-16
**Repos:** `~/personal/agentctl-publish`, `~/personal/orgloop`, `~/personal/arc`

---

## Vision

agentctl is a universal read/control interface for AI agent sessions. It reads from native sources (never replicates state), provides a standard CLI for humans and agents to list/peek/stop/launch sessions, and emits lifecycle events that OrgLoop routes to mechanical reactions.

**agentctl does NOT:**
- Maintain its own session registry (reads native sources)
- Have a hook/reaction system (that's OrgLoop)
- Make judgment calls about what to do (that's OpenClaw)

**Layer model:**
| Layer | Role |
|-------|------|
| agentctl | Universal read/control. Emits lifecycle events. |
| OrgLoop | Routes lifecycle events to mechanical reactions (cluster fuse, notifications). |
| OpenClaw | Reasoning/supervision. Makes judgment calls. |

---

## Phase 1: agentctl Core + Claude Code Adapter

### 1.1 Repo Setup

- TypeScript project, ESM-only
- GitHub: `c-h-/agentctl` (was `agent-ctl`, renamed)
- Runtime: Node.js + TypeScript (Bun-compatible)
- Package name: `agentctl` (npm)
- Binary: `agentctl` (primary), `agent-ctl` (compat alias)

### 1.2 Adapter Interface

```typescript
interface AgentAdapter {
  id: string;  // "claude-code", "openclaw", etc.

  // Discovery
  list(): Promise<AgentSession[]>;
  
  // Read
  peek(sessionId: string, opts?: { lines?: number }): Promise<string>;
  status(sessionId: string): Promise<AgentSession>;
  
  // Control
  launch(opts: LaunchOpts): Promise<AgentSession>;
  stop(sessionId: string, opts?: { force?: boolean }): Promise<void>;
  resume(sessionId: string, message: string): Promise<void>;
  
  // Lifecycle events
  // Adapters emit these; consumers (OrgLoop connector, ARC) subscribe
  events(): AsyncIterable<LifecycleEvent>;
}

interface AgentSession {
  id: string;
  adapter: string;           // Which adapter owns this
  status: 'running' | 'idle' | 'stopped' | 'error';
  startedAt: Date;
  stoppedAt?: Date;
  cwd?: string;
  spec?: string;             // Spec file path if applicable
  model?: string;
  prompt?: string;           // Launch prompt (truncated)
  tokens?: { in: number; out: number };
  cost?: number;
  pid?: number;              // OS process ID if available
  meta: Record<string, any>; // Adapter-specific (e.g. claude-code: { team: true, projectPath: "..." })
}

interface LifecycleEvent {
  type: 'session.started' | 'session.stopped' | 'session.idle' | 'session.error';
  adapter: string;
  sessionId: string;
  session: AgentSession;
  timestamp: Date;
  meta?: Record<string, any>;
}

interface LaunchOpts {
  adapter: string;
  prompt: string;
  spec?: string;
  cwd?: string;
  model?: string;
  env?: Record<string, string>;
  adapterOpts?: Record<string, any>; // Adapter-specific (e.g. { team: true, dangerouslySkipPermissions: true })
}
```

### 1.3 Claude Code Adapter

**Source of truth:** Claude Code's native session data at `~/.claude/projects/` and running processes.

**list():**
- Scan `~/.claude/projects/` for session directories
- Cross-reference with running `claude` processes (via `ps aux | grep claude`)
- Status is derived from PID liveness, NOT from a file registry
- Parse JSONL conversation files for token counts, model info
- Return only sessions from recent timeframe (configurable, default 7 days for stopped)

**peek(sessionId):**
- Read the session's JSONL conversation log
- Extract last N assistant messages
- Format as readable text

**stop(sessionId):**
- Send SIGTERM to the Claude Code process (graceful)
- `force: true` → SIGINT then SIGKILL

**resume(sessionId, message):**
- Use Claude Code's `--continue` flag with the session ID and new message
- Or pipe message to stdin if session is running

**launch(opts):**
- Build Claude Code command with appropriate flags:
  - `--dangerously-skip-permissions` (always, for autonomous use)
  - `--print --verbose --output-format stream-json`
  - `--model` if specified
  - `-p` with prompt
- Handle env var injection (QASE_*, OPENAI_*, ANTHROPIC_* from ~/.zshrc)
- Run in background, capture PID
- Return AgentSession immediately

**events():**
- Watch for process exits (PID monitoring)
- Watch `~/.claude/projects/` for new session directories (fs.watch)
- Emit started/stopped events

### 1.4 CLI

```bash
# List all sessions across all adapters
agentctl list
agentctl list --adapter claude-code
agentctl list --status running
agentctl list -a  # Include stopped/completed (last 7 days)

# Session details
agentctl status <id>
agentctl peek <id> [-n 50]

# Control
agentctl stop <id>
agentctl stop <id> --force
agentctl resume <id> "fix the failing tests"

# Launch (replaces claude-supervised)
agentctl launch claude-code \
  -p "Read the spec. Implement phase 2." \
  --spec docs/spec.md \
  --cwd ~/personal/my-project \
  --model sonnet

# Event stream (for debugging / piping to OrgLoop)
agentctl events --json
```

**Output format:** Human-friendly table by default, `--json` for machine consumption.

### 1.5 Acceptance Criteria — Phase 1

- [x] `agentctl list` shows only real, live Claude Code sessions (no stale ghosts)
- [x] `agentctl peek <id>` shows recent output from a running session
- [x] `agentctl stop <id>` gracefully stops a running session
- [x] `agentctl launch claude-code -p "hello"` starts a session (replaces claude-supervised)
- [x] `agentctl events --json` emits lifecycle events as NDJSON
- [x] Zero file-based registry — all state from native sources
- [x] Tests: unit tests for adapter (14 tests passing)
- [ ] Integration test launching+stopping a real session (deferred to Phase 2)

---

## Phase 2: Cut Over

### 2.1 Update Dependents
- Update `~/.openclaw/workspaces/personal/TOOLS.md` — document new `agentctl launch` syntax
- Update `~/.openclaw/workspaces/personal/CLAUDE_CODE_SOP.md` — replace `claude-supervised` references
- Update `~/personal/arc/daemon/src/adapters/` — swap to new agentctl interface
- Symlink or install `agentctl` binary globally (`npm link` or PATH addition)

### 2.2 Delete Old Artifacts
- `~/.openclaw/scripts/agentctl/` (old implementation)
- `~/.local/bin/claude-supervised` (absorbed into agentctl)
- `~/.openclaw/scripts/agentctl/sessions/` (stale file registry)
- `~/.local/bin/notify-doink.sh` or wherever the stop hook lives
- Any Claude Code Stop hook that calls notify-doink

### 2.3 Acceptance Criteria — Phase 2
- [ ] `claude-supervised` no longer exists; `agentctl launch` is the only way
- [ ] ARC dashboard shows live, accurate session data
- [ ] OpenClaw workspace docs reference new commands
- [ ] No stale session files anywhere on disk

---

## Phase 3: OrgLoop Connectors

### 3.1 `@orgloop/connector-agentctl` (Source)

Reads lifecycle events from agentctl and emits them as OrgLoop events.

```typescript
// connector-agentctl/src/index.ts
export default class AgentCtlConnector implements SourceConnector {
  // Runs `agentctl events --json` and pipes lifecycle events into OrgLoop
  // Or: polls `agentctl list --json` on interval (simpler, good enough)
  
  async poll(): Promise<OrgLoopEvent[]> {
    const sessions = await exec('agentctl list --json');
    // Diff against last poll, emit started/stopped events
  }
}
```

**Events emitted:**
- `session.started` — new session appeared
- `session.stopped` — session no longer running
- `session.idle` — session running but no output for N minutes

### 3.2 `@orgloop/connector-docker` (Actor)

Controls Docker/Kind clusters via OrgLoop routes.

```typescript
export default class DockerConnector implements ActorConnector {
  async act(event: OrgLoopEvent, config: ActorConfig): Promise<void> {
    switch (config.action) {
      case 'cluster.shutdown':
        await exec(`kind delete cluster --name ${config.clusterName}`);
        break;
      case 'cluster.start':
        await exec(`kind create cluster --config ${config.configPath}`);
        break;
      case 'container.stop':
        await exec(`docker stop ${config.containerName}`);
        break;
    }
  }
}
```

### 3.3 Example OrgLoop Route — Kind Cluster Fuse

```yaml
# In orgloop.yaml
sources:
  - id: agents
    connector: "@orgloop/connector-agentctl"
    poll: { interval: 30s }

actors:
  - id: kind-cluster
    connector: "@orgloop/connector-docker"
    config:
      clusterName: "kindo-dev"

routes:
  - name: "Last Claude Code team stopped → shut down Kind cluster"
    when:
      source: agents
      events: [session.stopped]
      filter: { adapter: "claude-code" }
    # Only fire when NO claude-code sessions remain running
    transforms: [require-no-running-sessions]
    then:
      actor: kind-cluster
    with:
      action: cluster.shutdown
      delay: 10m  # Grace period
```

### 3.4 Notification Migration

Current `notify-doink.sh` → OrgLoop route:

```yaml
routes:
  - name: "Agent session completed → notify OpenClaw"
    when:
      source: agents
      events: [session.stopped]
    then:
      actor: openclaw-supervisor
    with:
      prompt_file: "./sops/evaluate-dev-output.md"
```

### 3.5 Acceptance Criteria — Phase 3
- [ ] `@orgloop/connector-agentctl` published and working in OrgLoop pipeline
- [ ] `@orgloop/connector-docker` published and working
- [ ] Kind cluster fuse works via OrgLoop route (replaces bespoke bash script)
- [ ] Session completion notifications flow through OrgLoop → OpenClaw
- [ ] All bespoke notification/fuse scripts deleted

---

## Phase 4: Additional Adapters

### 4.1 OpenClaw Adapter
- Reads from OpenClaw gateway API (`/api/sessions` or equivalent)
- `list()` returns OpenClaw sessions with model, tokens, channel info
- `peek()` returns recent conversation history
- `stop()` / `resume()` via gateway API

### 4.2 Future Adapters
- OpenCode, Codex, Aider, etc. — same interface, different native sources
- Gas Town actors (once OrgLoop actors have session-like lifecycle)

### 4.3 ARC Simplification
- ARC's multiple adapters (agentctl, openclaw, github, git, system) consolidate
- agentctl becomes the single source for all agent data
- ARC keeps system/github/git adapters (those aren't agents)

---

## Build Plan — Claude Code Teams

### Team 1: agentctl core + Claude Code adapter
- **Repo:** `~/personal/agentctl`
- **Scope:** Phase 1 entirely — scaffold, adapter interface, Claude Code adapter, CLI, tests
- **Isolation:** Can build and test completely standalone
- **Depends on:** Nothing

### Team 2: OrgLoop connector-agentctl
- **Repo:** `~/personal/orgloop` (new package in monorepo)
- **Scope:** Phase 3.1 — source connector that reads from agentctl
- **Isolation:** Can build with mock agentctl output, test against real agentctl once Team 1 ships
- **Depends on:** agentctl CLI interface (Team 1 must define JSON output format first)

### Team 3: OrgLoop connector-docker
- **Repo:** `~/personal/orgloop` (new package in monorepo)
- **Scope:** Phase 3.2 — actor connector for Docker/Kind
- **Isolation:** Fully independent, just needs Docker CLI
- **Depends on:** Nothing (OrgLoop actor interface already defined)

### Integration (after all teams complete):
- Wire agentctl into ARC (Phase 4.3)
- Cut over from old scripts (Phase 2)
- Wire OrgLoop routes for cluster fuse + notifications (Phase 3.3-3.4)
- **This is done manually/supervised, not by Claude Code teams**

---

## Open Questions (Resolved)

| Question | Decision |
|----------|----------|
| Where does supervision loop live? | OpenClaw. agentctl is mechanical only. |
| Hook execution model? | No hooks in agentctl. OrgLoop handles reactions. |
| agentctl repo location? | Own private repo, pathway to open source npm. |
| Kind cluster fuse? | OrgLoop route via connector-docker, not bespoke script. |

---

## Git Identity

```bash
git commit --author="Jarvis (OpenClaw) <jarvis@openclaw.ai>" -m "feat(scope): desc"
# Co-Authored-By: Charlie Hulcher <charlie.hulcher@gmail.com>
```

Use `gh-me` for GitHub CLI (Charlie's personal account).
