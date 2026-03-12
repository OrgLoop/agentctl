# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.9.0] - 2026-03-12

fix: PID-based locks replace session-ID-coupled locks — self-healing, adapter-independent (#115). fix: pending-* entry cleanup — TTL + dead PID removal (#114). fix: LaunchedSessionMeta minimized with 24h TTL auto-cleanup, shared utility across all 5 adapters (#112). fix: session ID consistency — canonical IDs from launch, login failure detection (#134). fix: peek reliability for short-lived sessions via launch log fallback (#135). fix: stuck session detection and cleanup on daemon startup (#122).


## [1.8.0] - 2026-03-11

feat: Phase 1 ACP adoption via ACP transport. feat: callback metadata, lifecycle webhooks, spawn ENOENT retry. feat: complete stateless daemon core. fix: eliminate pending session IDs, resolve real ID at launch. fix: webhook emit numeric exit_status, compatible HMAC headers. fix: eliminate daemon-env.json, derive env at spawn time. fix: update resolve-binary util. docs: ADR-001 adopt ACP as primary agent interface. docs: audit and align documentation with current codebase.


### Added

- Phase 1 ACP adoption — Codex adapter via ACP transport (#125, #127)
- Lifecycle webhooks for `session.stopped` payloads (#123)
- Callback metadata (`--callback-session`, `--callback-agent`) for orchestration (#123)
- Spawn ENOENT retry for adapter launch resilience (#123)
- Complete stateless daemon core — eliminate remaining shadow state (#117)

### Fixed

- Eliminate pending- session IDs — resolve real ID at launch (#131)
- Webhook emit numeric `exit_status` + compatible HMAC headers (#128)
- Eliminate daemon-env.json — derive env at spawn time (#119)
- Update resolve-binary util (#121)

### Docs

- ADR-001: adopt ACP as primary agent interface (#126)

## [1.6.0] - 2026-03-06

### Added

- `--file` flag to include context files in launch prompts (#95)
- Use `history.jsonl` for Claude Code discover(), batch `lsof` calls (#96)

### Fixed

- Insert `--` separator before positional prompt args in codex/opencode/pi-rust (#106)
- Peek/status timeout on opencode sessions (#100)
- Use temp file for large prompts instead of CLI args (#101)

## [1.5.2] - 2026-03-02

### Fixed

- OpenCode detach, matrix prompt override, persistent config defaults (#87)
- Worktree slug collisions, pi-rust `--provider`/`--append-system-prompt` (#83)
- Pass `--model` flag when launching OpenCode (#79)

## [1.5.1] - 2026-02-27

### Fixed

- Resolve P0+P1 launcher/docs regressions (#76)

## [1.5.0] - 2026-02-25

### Added

- `logs` command as alias for `peek` (#62)

### Fixed

- Resolve pending- session IDs so `peek`/`stop`/`resume` work (#60, #63)
- Make on-create hook defaults sane (#68)
- Omit undefined fields in lock error messages (#61, #65, #66)

### Docs

- Document default `--cwd` behavior (#64)

## [1.4.0] - 2026-02-24

### Added

- Stateless daemon core (Phases 1-3) (#52)

## [1.3.0] - 2026-02-23

### Added

- CLI surface cleanup per ADR-003 (#49)
- Discover-first session tracking (ADR-002 Phase 2+3) (#46)

### Docs

- ADR-002: discover-first session tracking
- ADR-003: CLI surface and design principles

## [1.2.1] - 2026-02-23

### Added

- Adapter column to `agentctl list` output (#44)

### Fixed

- Improve daemon reliability across binary resolution, env, singleton, and session cleanup (#43)
- Resolve claude binary path and handle spawn errors gracefully (#38)

### Docs

- ADR-002: discover-first session tracking

## [1.2.0] - 2026-02-23

### Added

- Parallel multi-adapter launch (#33)
- Pi coding agent adapter (#32)
- OpenCode adapter for session discovery and control (#31)
- Codex CLI adapter (#29)
- Pi Rust adapter (#30)
- Ed25519 device auth for scoped gateway access (#26)

### Fixed

- Reduce daemon CPU saturation from full JSONL reads (#35)
- Reconcile pending-PID ghosts and add liveness checks (#28)
- Fix gateway handshake params and auth token resolution (#25)

## [1.1.0] - 2026-02-20

### Fixed

- Reap ghost sessions and deduplicate pending-* entries (#23)

## [1.0.1] - 2026-02-20

### Fixed

- Address docs issues #11-#17 (#19)

## [1.0.0] - 2026-02-20

### Added

- Core agentctl CLI with Claude Code adapter
- OpenClaw gateway adapter (#2)
- Daemon with locks, fuses, metrics (#5)
- Session lifecycle management with PID tracking (#4)
- PID recycling detection via process start time (#3)
- Session lifecycle bug fixes and feature queue (#7)
- Public release preparation (#6, #8)

### Fixed

- Match GitHub org casing for npm provenance (#10)
