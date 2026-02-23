# ADR-003: CLI Surface & Design Principles

**Status:** Accepted  
**Date:** 2026-02-23  
**Author:** Charlie + Doink

## Decisions

### 1. Adapters provide ground truth — CLI never guesses

The CLI is a thin presentation layer over adapter-reported data. If an adapter doesn't know something, the CLI shows "-" or "unknown" — it does NOT infer, estimate, or guess.

**Example (violated):** The OpenClaw adapter was marking sessions as "stopped" if `updatedAt` was >5 minutes ago. This is guessing. The gateway knows whether a session is alive — ask it, don't infer from timestamps.

**Principle:** Adapters own truth. CLI displays truth. Nothing in between.

### 2. Git-only — no other VCS support

agentctl targets the Git ecosystem exclusively. No SVN, Mercurial, Perforce, etc. This is a deliberate choice for simplicity and productivity. Worktree management, branch operations, and git-specific features are first-class concerns.

### 3. Worktree management stays

`agentctl worktree` is a core primitive, not a convenience wrapper. It's essential for multi-adapter launching — point at a cwd, agentctl creates worktrees per sweep combination. Removing it would break the parallel launch model.

### 4. Remove `merge` command

`agentctl merge` (commit + push + open PR) is an agent-level workflow concern. It couples agentctl to a specific git workflow that agents should manage themselves. Remove it.

### 5. Generic fuses + fuse events

Fuses stay in agentctl but must be fully generic:
- Directory-scoped TTL timers with configurable on-expire actions (webhook, event, script)
- Emit fuse lifecycle events: `fuse.set`, `fuse.extended`, `fuse.expired`
- OrgLoop or other consumers can route fuse events to arbitrary actions
- Zero references to Kind clusters, specific infrastructure, or any user's bespoke workflow

### 6. Separation of concerns

agentctl is a general-purpose agent session management tool. It must not contain features specific to any single user's workflow. Every feature should be useful to any developer managing AI coding agents.

**Test:** "Would a stranger using agentctl for the first time understand why this feature exists?" If not, it doesn't belong.

## Tracking

- Implementation: [#47](https://github.com/OrgLoop/agentctl/issues/47) (CLI audit)
- OpenClaw discover fix: [#48](https://github.com/OrgLoop/agentctl/issues/48)
