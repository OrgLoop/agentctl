# agentctl Work Queue

## Critical Bugs

### BUG-1: Store process start time alongside PID
**Status:** RESOLVED

Process start time is stored in `LaunchedSessionMeta.startTime` (captured via `ps -p <pid> -o lstart=` at launch) and in `PidInfo.startTime` (captured during `ps aux` scanning). On status check, the adapter compares stored start time against actual process start time. If they don't match, the PID was recycled — session is marked dead.

**Files:** `src/adapters/claude-code.ts`

### BUG-2: Track Claude Code PID separately from wrapper PID
**Status:** RESOLVED

`LaunchedSessionMeta` now includes both `pid` (Claude Code process) and `wrapperPid` (agentctl launch wrapper). Status checks verify the Claude Code PID, not the wrapper. The wrapper can die and Claude Code continues running.

**Files:** `src/adapters/claude-code.ts`

### BUG-3: Properly detach Claude Code process
**Status:** RESOLVED

Claude Code is spawned with `detached: true` and `child.unref()`. stdout is redirected to a log file (not piped, which would prevent detachment). The wrapper dying does NOT kill Claude Code. Session metadata is persisted to disk so status checks survive wrapper exit.

**Files:** `src/adapters/claude-code.ts`

### BUG-4: Session ID generation (pending- prefix bug)
**Status:** RESOLVED

`launch()` now:
1. Redirects Claude Code stdout to a log file
2. Polls the log for up to 5s to extract the real session ID from Claude Code's stream-json output
3. Falls back to `crypto.randomUUID()` if the session ID can't be extracted
4. Never returns `pending-<pid>` as the session ID

**Files:** `src/adapters/claude-code.ts`

### BUG-5: Session lifecycle tests
**Status:** RESOLVED

Added comprehensive lifecycle scenario tests:
- Wrapper dies → Claude Code continues → status shows "running"
- Claude Code completes → status shows "stopped"
- Old PID recycled → old session shows "stopped" not "running"
- Two sessions, same PID → only the live one shows "running"
- Session ID is not `pending-*` when metadata has real ID

**Files:** `src/adapters/claude-code.test.ts`

---

## Feature Requests

### FEAT-1: Integrated worktree lifecycle
**Status:** RESOLVED

`agentctl launch claude-code --worktree ~/code/mono --branch charlie/feature-name -p "..."`

Auto-creates git worktree at `<repo>-<branch-slug>`, sets cwd, launches agent. Reuses existing worktree if already created.

**Files:** `src/worktree.ts`, `src/worktree.test.ts`, `src/cli.ts`

### FEAT-3: Lifecycle hooks
**Status:** RESOLVED

`--on-create`, `--on-complete`, `--pre-merge`, `--post-merge` script hooks. Hook scripts receive context via environment variables: `AGENTCTL_SESSION_ID`, `AGENTCTL_CWD`, `AGENTCTL_ADAPTER`, `AGENTCTL_BRANCH`, `AGENTCTL_EXIT_CODE`.

**Files:** `src/hooks.ts`, `src/hooks.test.ts`, `src/core/types.ts`, `src/cli.ts`

### FEAT-4: Merge + cleanup command
**Status:** RESOLVED

`agentctl merge <session-id>` — commits uncommitted changes, pushes to remote, opens PR via `gh`, optionally removes worktree with `--remove-worktree --repo <path>`. Supports `--pre-merge` and `--post-merge` hooks.

**Files:** `src/merge.ts`, `src/merge.test.ts`, `src/cli.ts`

### FEAT-5: Daemon supervisor
**Status:** RESOLVED

Daemon supervisor with exponential backoff (1s, 2s, 4s... cap 5min). Resets backoff after 60s stable uptime. `daemon start` now launches the supervisor by default, which auto-restarts the daemon on crash. `daemon stop` kills both supervisor and daemon. LaunchAgent plist was already present (uses `KeepAlive` for macOS auto-start).

**Files:** `src/daemon/supervisor.ts`, `src/daemon/supervisor.test.ts`, `src/cli.ts`

### FEAT-2: A/B agent launches
**Status:** DEFERRED (lower priority, not implemented in this PR)

---

## Quality

- **Tests:** 131 passing (14 test files), up from 106 (10 test files)
- **Typecheck:** 0 errors
- **Lint:** 0 errors
- **Build:** Succeeds
