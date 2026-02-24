# ADR 004: Stateless Daemon Core

**Status:** Proposed  
**Date:** 2026-02-24  
**Author:** Doink (OpenClaw)  
**Related:** [#51](https://github.com/orgloop/agentctl/issues/51)

## Problem

The daemon maintains a `state.json` session registry that mirrors every session discovered by every adapter. Over 26 hours, this accumulated 394 "active" sessions because:

1. **OpenClaw sessions have no PID** — the reaper relies on PID liveness, so remote sessions are never cleaned up
2. **The daemon is a session database** — `session.list` reads from `StateManager`, not from adapters
3. **Pruning is a band-aid** — `pruneDeadSessions()`, `pruneOldSessions()`, `validateAllSessions()`, and `reapStaleEntries()` are all compensating for the fundamental error of duplicating adapter state in the daemon

The daemon acts as a **session database** when it should be a **stateless multiplexer**.

## Current Architecture

```
CLI → daemon → StateManager (state.json)
                    ↑
       SessionTracker.poll() merges adapter.discover() into state.json
```

- `session.list` → reads `StateManager.getSessions()` (daemon cache)
- `session.status` → reads `SessionTracker.getSession()` (daemon cache)
- `session.peek` → delegates to adapter (correct!)
- `session.stop` → delegates to adapter (correct!)
- `session.launch` → delegates to adapter, then `track()` into state (partially correct)

The `SessionTracker` polls every 5s, calling `discover()` on all adapters, merging results into `state.json`. Sessions enter state but exit only via PID death detection or periodic pruning. Remote sessions (OpenClaw) have no exit path.

## Adapter Audit

### Interface Contract (`AgentAdapter`)

| Method | Purpose | Ground truth? |
|--------|---------|--------------|
| `discover()` | Find all sessions from adapter runtime | ✅ Yes — this IS the source of truth |
| `isAlive(id)` | Check if a specific session is alive | ✅ Yes |
| `list(opts)` | List sessions with filtering | Delegates to discover internally |
| `status(id)` | Get session details | Queries backend directly |
| `peek(id)` | Read session output | Queries backend directly |
| `launch(opts)` | Start a session | Creates in backend |
| `stop(id)` | Stop a session | Stops in backend |
| `resume(id)` | Resume a session | Resumes in backend |
| `events()` | Lifecycle event stream | Polls backend |

The adapter interface is **already correct** — `discover()` returns ground truth from each backend. The problem is that the daemon doesn't use it that way. It copies discover results into its own state and serves from the copy.

### Per-Adapter Maturity

| Adapter | discover() source | Has PID? | Maturity | Notes |
|---------|------------------|----------|----------|-------|
| **claude-code** | `~/.claude` JSONL files + `ps` | ✅ Yes | High | Reads session index, cross-refs with running PIDs. Full lifecycle. |
| **openclaw** | Gateway RPC `sessions.list` | ❌ No | High | Gateway is source of truth. No local PID. **Primary victim of state accumulation.** |
| **pi** | `~/.pi` JSONL files + `ps` | ✅ Yes | High | Same pattern as claude-code, adapted for Pi sessions. |
| **pi-rust** | `~/.pi/agent/sessions` + `ps` | ✅ Yes | High | Same pattern, different session dir. |
| **opencode** | `~/.local/share/opencode/storage` + `ps` | ✅ Yes | High | Reads OpenCode JSON session files + message files. |
| **codex** | `~/.codex` JSONL files + `ps` | ✅ Yes | High | Same discover pattern as claude-code. |

All adapters implement the full interface. All are mature. The gap isn't adapter quality — it's the daemon's misuse of adapter output.

## Proposed Architecture: Stateless Core

```
CLI → daemon → fan-out to adapters → merge → return
                  ↓
          StateManager (minimal: launched PIDs, locks, fuses only)
```

### Principle: Adapters own session truth. Daemon owns what it launched.

### `session.list`

**Current:** Read from `StateManager` (stale cache).  
**Proposed:** Fan out `adapter.discover()` to all adapters in parallel, merge, return. No daemon-side session registry needed for listing.

```ts
case "session.list": {
  const results = await Promise.allSettled(
    Object.entries(ctx.adapters).map(([name, adapter]) =>
      adapter.discover().then(sessions => sessions.map(s => ({ ...s, adapter: name })))
    )
  );
  // Merge fulfilled results, skip failed adapters
  let sessions = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);
  // Apply filters, enrich with daemon-only metadata (launch prompts, groups)
  return sessions;
}
```

### `session.status`

**Current:** Read from `SessionTracker.getSession()` (daemon cache).  
**Proposed:** Route to the correct adapter's `status(id)`. Use daemon metadata to enrich (launch prompt, group tag).

If the session ID prefix matches a known adapter (from launch metadata), route directly. Otherwise, fan out `isAlive(id)` to find the right adapter.

### What the Daemon Still Needs to Track

| State | Why | Scope |
|-------|-----|-------|
| **Launch metadata** | PIDs the daemon spawned, prompts, group tags, specs | Only sessions launched via `agentctl launch` |
| **Locks** | Local worktree locks | Adapter-scoped (only local adapters need locks) |
| **Fuses** | Timeout timers for sessions | Tied to directories, not sessions |

This is ~10-20 records at any time, not 394.

### What the Daemon Stops Tracking

- **All discovered sessions** — adapters own this
- **Session status** — adapters own this
- **Historical sessions** — query adapters with `list({ all: true })`

### SessionTracker Changes

The `SessionTracker` class gets dramatically simplified:

- **Remove:** `poll()`, `reapStaleEntries()`, `validateAllSessions()`, `pruneDeadSessions()`, `pruneOldSessions()`, `listSessions()`
- **Keep:** `track()` (for launch metadata only), `getSession()` (for daemon-launched enrichment), `onSessionExit()` (for lock/fuse cleanup)
- **Add:** `enrichWithLaunchMeta(discoveredSessions)` — merges daemon launch metadata (prompt, group, spec) into adapter-discovered sessions

The 5-second polling loop goes away entirely. No more background reconciliation.

## Locks

### Current Model
Locks are directory-scoped in `StateManager`. `autoLock(cwd, sessionId)` on launch, `autoUnlock(sessionId)` on stop.

### Proposed Model
Locks stay as-is but are **only meaningful for local adapters** (claude-code, pi, pi-rust, opencode, codex). OpenClaw sessions don't use local worktrees, so they never acquire locks.

The lock model is actually fine. The bug (#51) where locks accumulated was because `reapStaleEntries()` didn't call `autoUnlock()` — that's a simple fix independent of this architecture change.

**One improvement:** Lock cleanup should be tied to launch metadata, not session discovery. When a daemon-launched session's PID dies, release its lock. This is a simple PID liveness check on the small set of daemon-launched sessions, not a reconciliation of all discovered sessions.

## Migration Path

### Phase 1: Fix the immediate bug (quick)
- In `poll()`, track which adapter IDs were returned by `discover()`. Sessions in state whose adapter succeeded but whose ID wasn't returned → mark stopped + autoUnlock.
- This stops the accumulation without architectural change.

### Phase 2: Make `session.list` adapter-first (medium)
- Change `session.list` handler to fan out `discover()` to adapters
- Enrich with daemon launch metadata (prompt, group, spec)
- Keep `StateManager.sessions` as a **write-through cache** for launch metadata only
- Remove the 5s polling loop

### Phase 3: Clean up (small)
- Remove `SessionTracker.poll()`, `reapStaleEntries()`, all pruning code
- Simplify `StateManager` to only persist launch metadata, locks, fuses
- Remove `state.json` session entries (or reduce to launch-metadata-only)

### Phase 4: Separate launch metadata from session state
- New `launches.json` (small, ~10 entries) replaces sessions in `state.json`
- `state.json` becomes locks + fuses only
- Clean separation of concerns

## Risks

1. **Fan-out latency**: 6 adapters × discover() could be slower than reading cache. Mitigation: parallel execution, timeouts per adapter, skip failed adapters gracefully.
2. **Adapter failures**: If OpenClaw gateway is down, `session.list` loses those sessions. Mitigation: return partial results with a warning, not an error.
3. **Launch metadata loss**: If we stop persisting all sessions, we lose the prompt/spec/group for sessions not launched via agentctl. This is acceptable — those sessions have their own metadata in their backends.

## Decision

Implement phases 1-3. Phase 4 is optional cleanup.
