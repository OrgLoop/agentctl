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
- `src/adapters/openclaw.ts` — OpenClaw gateway adapter (WebSocket RPC)
- `src/adapters/opencode.ts` — OpenCode adapter (reads ~/.local/share/opencode/storage/, cross-refs PIDs)
- `src/adapters/pi-rust.ts` — Pi Rust adapter (reads ~/.pi/agent/sessions/, cross-refs PIDs)
- `src/cli.ts` — CLI entry point (commander)
- `src/daemon/server.ts` — Daemon: Unix socket server + HTTP metrics
- `src/daemon/session-tracker.ts` — Session lifecycle tracking
- `src/daemon/lock-manager.ts` — Auto + manual directory locks
- `src/daemon/fuse-engine.ts` — Kind cluster fuse timers
- `src/daemon/metrics.ts` — Prometheus metrics registry
- `src/daemon/state.ts` — State persistence layer
- `src/client/daemon-client.ts` — Unix socket client for CLI
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

Bumps version, builds, tags, and runs `npm link`. No npm publish (local tool).

## CI

GitHub Actions runs on push/PR to main: install → lint → typecheck → build → test.
