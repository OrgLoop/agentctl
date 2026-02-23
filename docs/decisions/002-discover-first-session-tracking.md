# ADR-002: Discover-First Session Tracking

**Status:** Accepted
**Date:** 2026-02-23
**Author:** Doink + Charlie  
**Relates to:** Issues #37, #39, #40, #41, #42

## Context

agentctl's current architecture maintains a daemon-side JSON state file as the source of truth for session lifecycle. The daemon tracks sessions from launch through completion, recording PIDs, status, metadata, and adapter associations.

This design has produced a recurring class of bugs:

- **Ghost sessions** (#40): Sessions marked "running" in state when the process is long dead. PIDs from crashed daemons are never rechecked.
- **Multiple daemons** (#39): When singleton enforcement fails, multiple daemons each maintain their own view of state, causing duplicates (808 sessions observed).
- **Stale state after crashes**: Daemon crash = state frozen at crash time. Restart doesn't reconcile with reality.
- **PID fragility**: PID tracking is inherently a distributed synchronization problem — recycling, zombies, race conditions.

These are not independent bugs. They're symptoms of a **state-first architecture** where agentctl's internal state can diverge from ground truth (what's actually running on the host).

## Decision

Pivot to a **discover-first** model where each adapter is the authoritative source for its own session lifecycle. agentctl's state becomes a metadata overlay, not the source of truth.

### Core Design

```
agentctl list =
  for each adapter:
    live = adapter.discover()    // ground truth from adapter runtime
    enriched = merge(live, metadata_store.get(adapter))
  return enriched
```

### Adapter Contract

Each adapter implements:

```typescript
interface AdapterDiscovery {
  /** Find all sessions currently managed by this adapter's runtime.
   *  This is the source of truth for "what exists." */
  discover(): Promise<DiscoveredSession[]>;

  /** Check if a specific session is still alive.
   *  More targeted than discover() — used for status checks. */
  isAlive(sessionId: string): Promise<boolean>;
}

interface DiscoveredSession {
  id: string;
  status: "running" | "stopped";
  adapter: string;
  cwd?: string;
  model?: string;
  startedAt?: Date;
  stoppedAt?: Date;
  // Adapter-native fields — whatever the runtime provides
  nativeMetadata?: Record<string, unknown>;
}
```

### Adapter-Specific Discovery

| Adapter | Discovery Method | Cost |
|---------|-----------------|------|
| claude-code | Read `~/.claude/projects/*/` JSONL files + `ps` PID check | Cheap (filesystem) |
| codex | Check Codex CLI state / process list | Cheap |
| pi | Check pi process list + session files | Cheap |
| pi-rust | Check pi_agent_rust processes | Cheap |
| opencode | Check OpenCode session state | Cheap |
| openclaw | Query gateway API (`sessions.list`) | Medium (HTTP) |

### Metadata Store

agentctl still maintains metadata that adapters don't natively track:

- **Launch prompt** (the `-p` argument)
- **Labels / groups** (user-assigned)
- **Launch time** (if not available from adapter)
- **CWD** (if not inferrable from adapter)
- **User annotations**

This is stored in `~/.agentctl/metadata/` (or similar), keyed by session ID. It's purely supplementary — if a session isn't discoverable, its metadata is irrelevant (and can be garbage collected).

### How This Fixes Each Bug

| Bug | State-First Problem | Discover-First Solution |
|-----|-------------------|----------------------|
| #39 Multiple daemons | Each daemon has its own state copy | No daemon state to duplicate — adapters are stateless discovery |
| #40 Ghost sessions | Dead PIDs stay "running" in state | `discover()` only returns live sessions |
| #41 Binary resolution | Daemon spawns binaries | Still relevant but less critical — daemon is simpler |
| #42 Env loss | Daemon env affects spawns | Still relevant for launch, but discovery is env-independent |
| Daemon crashes | State frozen at crash time | Restart → rediscover → zero data loss |

### Caching Strategy

`discover()` is called on every `list`, `status`, etc. To keep it fast:

- **Short TTL cache** (5-10 seconds) for `discover()` results
- **Background refresh** — daemon periodically calls `discover()` and caches
- **Force-refresh flag** — `agentctl list --refresh` bypasses cache
- **Stale-while-revalidate** — return cached data immediately, refresh in background

### Migration Path

1. **Phase 1 (current PR):** Ship reliability fixes (#39-#42) within the state-first model. Stop the bleeding.
2. **Phase 2:** Add `discover()` to each adapter alongside existing tracking. Run both in parallel, log discrepancies.
3. **Phase 3:** Switch `list`/`status` to discover-first. State file becomes metadata-only.
4. **Phase 4:** Remove state-based lifecycle tracking. Simplify daemon significantly.

## Consequences

### Positive
- Eliminates entire class of state-drift bugs
- Daemon becomes much simpler (no lifecycle state machine)
- Daemon crashes are non-events
- New adapters only need to implement `discover()` — no state integration
- `agentctl list` is always accurate

### Negative
- Each adapter needs a `discover()` implementation (one-time cost)
- Remote adapters may have slower discovery (mitigated by caching)
- Some metadata (launch prompt) must be stored separately since adapters don't track it
- Migration requires running dual systems temporarily

### Neutral
- Daemon still needed for: launch orchestration, metadata store, event streaming, lock management
- The daemon becomes a thinner coordinator rather than a state manager

## Open Questions

1. **Event streaming:** Currently the daemon emits lifecycle events by watching state transitions. In discover-first, events would come from polling `discover()` diffs. Is polling sufficient, or do we need adapter-specific event hooks?
2. **Session grouping:** The `--label` / group feature depends on metadata. How do we handle labels for sessions that were started outside agentctl (e.g., manually running `claude`)?
3. **Historical data:** Should we keep a log of past sessions for `agentctl list -a` (all, including stopped)? Or is that purely a metadata concern?
