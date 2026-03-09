# agentctl

Universal agent supervision interface — monitor and control AI coding agents from a single CLI.

## Quick Start

```bash
npm install
npm run build
npm link         # makes `agentctl` available globally
```

## Development

```bash
npm run dev      # run CLI via tsx (no build needed)
npm test         # vitest run
npm run test:watch
npm run typecheck  # tsc --noEmit
npm run lint       # biome check
npm run lint:fix   # biome check --write
```

## Project Structure

- `src/core/types.ts` — Core interfaces (AgentAdapter, AgentSession, etc.)
- `src/adapters/claude-code.ts` — Claude Code adapter (reads ~/.claude/, cross-refs PIDs)
- `src/adapters/codex.ts` — Codex CLI adapter (reads ~/.codex/sessions/, cross-refs PIDs)
- `src/adapters/codex-acp.ts` — Codex via ACP transport (uses @zed-industries/codex-acp bridge)
- `src/adapters/acp/acp-client.ts` — Generic ACP client (spawns agent, manages connection via ACP SDK)
- `src/adapters/acp/acp-adapter.ts` — Generic ACP-backed AgentAdapter implementation
- `src/adapters/openclaw.ts` — OpenClaw gateway adapter (WebSocket RPC)
- `src/adapters/opencode.ts` — OpenCode adapter (reads ~/.local/share/opencode/storage/, cross-refs PIDs)
- `src/adapters/pi.ts` — Pi coding agent adapter (reads ~/.pi/, cross-refs PIDs)
- `src/adapters/pi-rust.ts` — Pi Rust adapter (reads ~/.pi/agent/sessions/, cross-refs PIDs)
- `src/launch-orchestrator.ts` — Parallel multi-adapter launch orchestration (group IDs, worktree creation, parallel dispatch)
- `src/matrix-parser.ts` — YAML matrix file parser + cross-product expansion for sweep launches
- `src/worktree.ts` — Git worktree create/list/clean utilities
- `src/hooks.ts` — Lifecycle hook runner (env vars: AGENTCTL_SESSION_ID, AGENTCTL_CWD, AGENTCTL_ADAPTER, AGENTCTL_BRANCH, AGENTCTL_EXIT_CODE, AGENTCTL_GROUP, AGENTCTL_MODEL)
- `src/cli.ts` — CLI entry point (commander)
- `src/daemon/server.ts` — Daemon: Unix socket server + HTTP metrics
- `src/daemon/supervisor.ts` — Daemon supervisor (auto-restart on crash)
- `src/daemon/session-tracker.ts` — Session lifecycle tracking
- `src/daemon/lock-manager.ts` — Auto + manual directory locks
- `src/daemon/fuse-engine.ts` — Generic directory-scoped TTL fuse timers with configurable on-expire actions
- `src/daemon/webhook.ts` — Webhook event emission (session.stopped)
- `src/daemon/metrics.ts` — Prometheus metrics registry
- `src/daemon/state.ts` — State persistence layer
- `src/client/daemon-client.ts` — Unix socket client for CLI
- `src/file-context.ts` — File context builder (--file/--spec flags)
- `src/utils/config.ts` — Configuration loading (~/.agentctl/config.json)
- `src/utils/resolve-binary.ts` — Binary path resolution
- `src/utils/prompt-file.ts` — Prompt file handling (large prompts via temp files)
- `src/utils/spawn-with-retry.ts` — Spawn with ENOENT retry
- `src/utils/display.ts` — Display formatting utilities
- `src/migration/migrate-locks.ts` — Migration from ~/.openclaw/locks

## Conventions

- **Language:** TypeScript (strict mode), ESM-only (`"type": "module"`)
- **Testing:** vitest — test files live next to source (`*.test.ts`)
- **Linting:** biome (check + format)
- **Build:** tsc → dist/

## Git

- **Branch protection:** main requires PR review (do not push directly)
- **Pre-push hook:** runs build + test before push

## Release

```bash
./scripts/release.sh [patch|minor|major]
```

Bumps version, builds, and pushes release branch. Tag push triggers npm publish via GitHub Actions. See RELEASING.md for full workflow.

## CI

GitHub Actions runs on push/PR to main: install → lint → typecheck → build → test.

## Quality Gate — MANDATORY Before Declaring Done

**The work is not done until ALL of these pass:**

1. `npm run typecheck` — zero errors
2. `npm run lint` — zero errors (use `lint:fix` first)
3. `npm run build` — succeeds
4. `npm test` — all tests pass
5. **New logic requires new tests.** If you added or changed a function, write a test for it.
6. **If you can't make tests pass, say so explicitly.** Do not silently skip failing tests.

### Anti-Patterns — DO NOT:
- ❌ Commit without running the full verify suite (typecheck + lint + build + test)
- ❌ Skip writing tests for new functionality
- ❌ Declare "done" when tests are failing
- ❌ Assume the code works because it compiles
