---
title: "ADR-001 — agentctl adopts ACP as primary agent interface"
date: 2026-03-09
status: accepted
deciders: Charlie
tags: [type/adr, domain/agentctl]
---

# ADR-001: agentctl adopts ACP as primary agent interface

## Status
**Accepted** — 2026-03-09

## Context

agentctl (v1.6.0) currently maintains bespoke adapters for each coding agent runtime: Claude Code, Codex, OpenCode, Pi, Pi Rust. Each adapter handles launch, resume, PTY management, output parsing, and lifecycle detection independently. This approach has worked but creates a growing maintenance burden — every new runtime needs a new adapter, and each adapter re-solves the same problems (session management, structured output, permission mediation, crash recovery).

Meanwhile, the **Agent Client Protocol (ACP)** has emerged as a standard for structured agent-to-agent communication, and **ACPx** (github.com/openclaw/acpx) provides a mature headless ACP client runtime with persistent sessions, cooperative cancel, filesystem/terminal callbacks, and a growing registry of ACP-capable agent bridges.

Research ([acpx-vs-agentctl analysis](obsidian://open?vault=My%20Notes&file=Projects%2Fresearch%2Facpx-vs-agentctl)) confirms:
- ACPx handles the **transport/session/protocol layer** well (structured JSON-RPC, no PTY scraping)
- agentctl's differentiation is the **supervision/orchestration layer** (daemon, fleet discovery, worktrees, locks, fuses, metrics, event routing)
- There is meaningful overlap in launch/resume/lifecycle plumbing that should not be maintained in two places

## Decision

**agentctl will adopt ACP as its primary agent interface strategy.**

### Principles

1. **Ride on ACP, don't fight it.** agentctl's CLI and internal APIs should align with ACP primitives (sessions, prompts, cancel, permissions). Where ACP provides a clean abstraction, use it rather than reinventing.

2. **Adapters become thin ACP integration layers.** For agents with existing ACP bridges (Claude Code, Codex, OpenCode, Pi), adapters should delegate launch/session/lifecycle to ACP (via ACPx or direct ACP client) and only add agentctl-specific concerns (locks, metrics, hooks, worktree management).

3. **Build ACP clients for harnesses that lack them.** If a runtime doesn't have an ACP bridge, agentctl's contribution is to build one — potentially releasing it upstream or as a standalone package — rather than building yet another bespoke PTY-scraping adapter.

4. **Supervision stays in agentctl.** ACP/ACPx handles single-session lifecycle. agentctl handles multi-session fleet supervision: daemon, discovery, worktree orchestration, locks, fuses, metrics, webhooks, and operator UX. This is the durable differentiation.

5. **Contribute upstream where it benefits the ecosystem.** Generic improvements to ACP session management, error handling, or agent bridges should be contributed to ACPx or relevant ACP adapter repos rather than kept proprietary.

### What changes

| Area | Before | After |
|------|--------|-------|
| Agent launch/resume | Each adapter implements PTY spawn + output parsing | Delegate to ACP session (via ACPx or embedded ACP client) |
| Structured output | PTY scraping + regex | ACP JSON-RPC stream |
| Session persistence | agentctl-managed state files | ACP session model (ACPx handles persistence) |
| Permission mediation | N/A (PTY auto-approve or manual) | ACP permission callbacks with policy |
| New runtime support | Write a full adapter (~500-800 LOC) | Write or find an ACP bridge (~100-200 LOC), thin agentctl config |
| Crash recovery | Per-adapter process detection | ACP reconnect / session load |

### What stays the same

- Daemon supervision architecture
- Fleet discovery (`agentctl list`)
- Worktree management and sweeps
- Directory locks and fuses
- Prometheus metrics
- Webhook/callback hooks
- OrgLoop integration
- CLI UX and operator experience

## Consequences

**Positive:**
- Dramatically reduced adapter maintenance surface
- Structured agent output without PTY scraping
- New runtime support becomes trivial (find/build ACP bridge, add config)
- Better crash recovery via ACP session model
- Community alignment — contributing to ACP ecosystem instead of maintaining parallel infrastructure

**Negative:**
- ACP/ACPx is still alpha — API surface may shift
- Temporary dual-path: existing adapters work today, ACP migration is incremental
- Dependency on external project for protocol layer (mitigated: ACPx is MIT, we can fork if abandoned)

**Risks:**
- ACPx development could stall (mitigation: agentctl can embed ACP client directly)
- ACP protocol may not cover all edge cases bespoke adapters handle today (mitigation: contribute missing capabilities upstream)

## References
- [ACPx vs agentctl analysis](obsidian://open?vault=My%20Notes&file=Projects%2Fresearch%2Facpx-vs-agentctl)
- [ACPx repo](https://github.com/openclaw/acpx)
- [ACP specification](https://github.com/AgenClientProtocol/acp)
- [agentctl repo](https://github.com/OrgLoop/agentctl)
