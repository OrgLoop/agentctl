# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.5.0] - 2026-02-26

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
