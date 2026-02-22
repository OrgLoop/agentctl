# agentctl: Parallel Multi-Adapter Launch

**Date:** 2026-02-22
**Status:** Proposal (v3)
**Inspiration:** [dmux](https://github.com/standardagents/dmux) by Justin Schroeder (FormKit)

---

## Core Idea

Extend `agentctl launch` to accept multiple `--adapter` flags. Each gets its own git worktree and runs the same prompt in isolation. Results show up in normal `agentctl list`/`status` — no new commands. Each can open its own PR. User decides what to do with results.

**Not a race. Not auto-compared. Not auto-pruned.** Just: launch N agents in parallel, each isolated, and let humans or reviewer systems decide.

---

## UX

### Simple: Multiple Adapters

```bash
agentctl launch \
  --adapter claude-code \
  --adapter codex \
  --adapter pi \
  --cwd ~/code/mono \
  -p "Implement the caching layer"

# Launched 3 sessions (group: g-a1b2c3):
#   claude-code  → ~/code/mono-g-a1b2c3-claude-code
#   codex        → ~/code/mono-g-a1b2c3-codex
#   pi           → ~/code/mono-g-a1b2c3-pi
```

### Adapter + Model Combos

What if you want the same adapter with different models?

```bash
agentctl launch \
  --adapter claude-code --model claude-opus-4-6 \
  --adapter claude-code --model claude-sonnet-4-5 \
  --adapter codex \
  --cwd ~/code/mono \
  -p "Refactor the auth module"

# Launched 3 sessions (group: g-x1y2z3):
#   claude-code (opus-4-6)    → ~/code/mono-g-x1y2z3-cc-opus
#   claude-code (sonnet-4-5)  → ~/code/mono-g-x1y2z3-cc-sonnet
#   codex                     → ~/code/mono-g-x1y2z3-codex
```

Each `--adapter` starts a new "slot." `--model` binds to the preceding `--adapter`. When the same adapter appears twice, the worktree name disambiguates using the model short name.

### Status — Just Works

```bash
agentctl list

# GROUP column appears when groups exist:
# ID        STATUS   ADAPTER      MODEL           GROUP      CWD                              PROMPT
# f3a1...   running  claude-code  opus-4-6        g-x1y2z3   ~/mono-g-x1y2z3-cc-opus          Refactor the...
# 8b2c...   running  claude-code  sonnet-4-5      g-x1y2z3   ~/mono-g-x1y2z3-cc-sonnet        Refactor the...
# c4d3...   done     codex        gpt-5.2-codex   g-x1y2z3   ~/mono-g-x1y2z3-codex            Refactor the...
# a1e2...   running  claude-code  -               -          ~/code/mono-my-feature            Something else
```

No new commands. Groups are just a tag on sessions for understanding provenance.

---

## Appendix: Configuration Matrices

The simple CLI handles the common case: pick adapters and optionally models. But there's a richer space of variables you might want to sweep:

| Dimension | Example Values | Complexity |
|-----------|---------------|------------|
| Adapter | claude-code, codex, pi, opencode | Low — CLI flags |
| Model | opus-4-6, sonnet-4-5, gpt-5.2-codex | Low — CLI flags |
| Thinking/reasoning | off, low, medium, high | Medium |
| Prompt variants | "implement X", "implement X with tests first" | Medium |
| Temperature | 0.0, 0.5, 1.0 | High |
| System prompt | different AGENTS.md / context files | High |

### The Tension

Expressing a full matrix in CLI flags gets ugly fast:

```bash
# This is not elegant
agentctl launch \
  --adapter claude-code --model opus --thinking high \
  --adapter claude-code --model opus --thinking low \
  --adapter claude-code --model sonnet --thinking high \
  --adapter claude-code --model sonnet --thinking low \
  --adapter codex \
  -p "..."
```

That's 5 sessions from a 2×2 matrix + 1. Combinatorial explosion.

### Recommendation: Two Tiers

**Tier 1 — CLI (what we build now)**
Adapter + model combos only. Covers 90% of use cases. Clean, composable, no new syntax to learn.

```bash
agentctl launch --adapter A --model M1 --adapter A --model M2 --adapter B -p "..."
```

**Tier 2 — Matrix file (future, if needed)**
For advanced sweeps, a YAML config that defines the matrix:

```yaml
# agentctl-matrix.yaml
prompt: "Implement the caching layer"
cwd: ~/code/mono
matrix:
  - adapter: claude-code
    model: claude-opus-4-6
    thinking: [low, high]
  - adapter: claude-code
    model: claude-sonnet-4-5
  - adapter: codex
```

```bash
agentctl launch --matrix agentctl-matrix.yaml
```

This generates the cross-product and launches all variants. But this is explicitly **backlogged** — we build it only if the CLI tier proves insufficient and there's real demand for sweeps.

**The key insight:** we don't need to design the matrix interface now. The group/worktree/parallel-launch infrastructure is the same regardless. Tier 2 is just a different way to generate the launch list.

---

## Architecture

```d2
direction: down

user: User {
  shape: person
}

launch: "agentctl launch\n--adapter claude-code --model opus\n--adapter claude-code --model sonnet\n--adapter codex" {
  shape: terminal
  style.fill: "#1a1a2e"
  style.font-color: "#e0e0e0"
}

user -> launch

orchestrator: Launch Orchestrator {
  style.fill: "#16213e"
  style.font-color: "#e0e0e0"

  parse: "Parse adapter+model slots"
  group: "Generate group tag\n(g-a1b2c3)"
  worktrees: "Create worktrees\n(git worktree add)"
  hooks: "Run on_worktree_create\nhooks (install deps, etc.)"
  sessions: "Launch adapters\n(parallel)"

  parse -> group -> worktrees -> hooks -> sessions
}

launch -> orchestrator

wt1: "claude-code (opus)\n~/mono-g-a1b2c3-cc-opus\nbranch: try/a1b2c3/cc-opus" {
  style.fill: "#0f3460"
  style.font-color: "#e0e0e0"
}
wt2: "claude-code (sonnet)\n~/mono-g-a1b2c3-cc-sonnet\nbranch: try/a1b2c3/cc-sonnet" {
  style.fill: "#0f3460"
  style.font-color: "#e0e0e0"
}
wt3: "codex\n~/mono-g-a1b2c3-codex\nbranch: try/a1b2c3/codex" {
  style.fill: "#0f3460"
  style.font-color: "#e0e0e0"
}

orchestrator -> wt1
orchestrator -> wt2
orchestrator -> wt3

daemon: Daemon {
  style.fill: "#533483"
  style.font-color: "#e0e0e0"

  tracker: "Session Tracker\n(sessions have group tag)"
  locks: "Lock Manager\n(group-aware:\nsame group = cooperative)"
  events: "Lifecycle Events\n(session.started/stopped\nwith group metadata)"
}

wt1 -> daemon.tracker
wt2 -> daemon.tracker
wt3 -> daemon.tracker

list: "agentctl list\n(GROUP column when\ngroups exist)" {
  shape: terminal
  style.fill: "#1a1a2e"
  style.font-color: "#e0e0e0"
}

daemon -> list

user_decides: "User / Reviewer / OrgLoop\ndecides what to keep" {
  style.fill: "#2a2a4a"
  style.font-color: "#e0e0e0"
  style.stroke-dash: 3
}

list -> user_decides
```

---

## What's Valuable from dmux

| Feature | Take? | Notes |
|---------|-------|-------|
| Worktree-per-agent isolation | ✅ Yes | Core of the feature |
| A/B same prompt, multiple agents | ✅ Yes | Our multi-adapter launch |
| Lifecycle hooks | ✅ Yes | `on_worktree_create` for bootstrap, `on_session_complete` for teardown. Group metadata forwarded in hook context if it fits naturally. |
| AI-generated branch names | 📋 Backlog | Nice, route to a weak/cheap model. Not essential for v1. |
| Smart merge (auto-commit + merge + cleanup) | ⚠️ Careful | Risk of scope creep — agentctl is a *supervision layer*, not an agent itself. Better as an OrgLoop SOP or external script than built-in agentctl logic. Could expose `agentctl worktree clean` for the mechanical parts (remove worktree + branch) without the merge intelligence. |
| Multi-project sessions | 🔮 Future | Not needed yet |
| tmux TUI | ❌ No | Headless-first |

### Design Principle: Stay Thin

agentctl's value is being a **lightweight supervision layer** across many agent runtimes. Every feature should pass the test: *"Is this about supervising agents, or about being an agent?"*

- Worktree creation/cleanup → supervision ✅
- Lifecycle hooks → supervision ✅ (let external systems handle the logic)
- Smart merge with conflict resolution → being an agent ❌ (belongs in OrgLoop/reviewer)
- Auto-comparison of outputs → being an agent ❌

When in doubt, expose the primitive (worktree clean, hook event) and let OrgLoop/scripts/humans handle the decision logic.

---

## Groups

Groups are **tags, not entities**. No lifecycle, no state machine, no separate tracking.

- A group is a short ID (`g-a1b2c3`) stored as a field on each `AgentSession`
- `agentctl list` shows a GROUP column when any sessions have group tags
- Groups are created implicitly by multi-adapter launch
- Groups are never explicitly created, updated, or deleted
- Hooks receive group metadata in their context (if present) — no special group events

```typescript
// Addition to AgentSession type
interface AgentSession {
  // ... existing fields ...
  group?: string;  // launch group tag, e.g. "g-a1b2c3"
}
```

---

## Lock Manager Integration

**Current behavior:** One session per directory. Launching in a locked directory fails.

**With groups:** Multiple sessions target the same *source* repo but each gets its own worktree. The lock is on the *worktree*, not the source repo.

```
Source: ~/code/mono (not locked — no one's working directly in it)
  └─ Worktree: ~/code/mono-g-a1b2c3-cc-opus   (locked by session f3a1)
  └─ Worktree: ~/code/mono-g-a1b2c3-cc-sonnet  (locked by session 8b2c)
  └─ Worktree: ~/code/mono-g-a1b2c3-codex      (locked by session c4d3)
```

Each worktree gets its own lock. No special group-awareness needed — the existing lock model works because worktrees are separate directories. The orchestrator just needs to create the worktrees before launching (which it already does).

**Edge case:** What if someone is already working in `~/code/mono` directly? The orchestrator should check if the source repo has active sessions and warn (not block — the worktrees are isolated).

---

## Implementation Plan

### Phase 1: Multi-Adapter Launch
- Extend `launch` CLI to accept multiple `--adapter` (and optional `--model`) flags
- Launch orchestrator: parse slots → generate group ID → create worktrees → launch parallel
- Add `group` field to `AgentSession`
- Show GROUP column in `list` when any sessions have groups
- Worktree naming: `<repo>-g-<groupId>-<adapter>[-<model-short>]`
- Branch naming: `try/<groupId>/<adapter>[-<model-short>]`

### Phase 2: Worktree Lifecycle
- `agentctl worktree list` — show all agentctl-managed worktrees (with group, session, status)
- `agentctl worktree clean <group|session-id>` — remove worktree + branch
- Hooks: `on_worktree_create` (pre-agent bootstrap), `on_session_complete` (post-agent teardown)
- Hook context includes: group tag, adapter, model, cwd, session ID

### Backlog
- AI-generated branch names (weak model)
- Matrix file (`--matrix config.yaml`) for advanced sweeps
- Multi-project groups
- Per-adapter statistics / historical tracking

---

## References

- [dmux repo](https://github.com/standardagents/dmux)
- [workmux](https://github.com/raine/workmux) — similar concept
- [Tweet from @jpschroeder](https://x.com/jpschroeder/status/2024507517359788224)
- agentctl existing: `src/worktree.ts`, `src/hooks.ts`, lock manager, session tracker, 6 adapters
