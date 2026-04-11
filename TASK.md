# TASK: Fix single-entry matrix ignoring branch/base_branch (#39)

## Bug

When `agentctl launch --matrix file.yaml` has a single matrix entry with `branch` and `base_branch` fields, those fields are silently ignored. The agent launches in the `cwd` directory (e.g., the main repo checkout) instead of an isolated worktree.

## Root Cause

In `src/cli.ts` around line ~672: `if (slots.length > 1)` gates the parallel path which calls `orchestrateLaunch()` → `createWorktree()`. A single-entry matrix falls to the single-adapter path, which only creates worktrees when `--worktree` is passed as an explicit CLI flag.

## Fix

The single-entry matrix path must also honor `branch` and `base_branch` from the matrix entry. When a matrix entry specifies a branch, worktree creation should happen regardless of whether it's a single or multi-entry matrix.

Approaches:
1. Remove the `slots.length > 1` guard entirely — always use `orchestrateLaunch()` for matrix entries
2. OR: in the single-entry fallback path, extract `branch`/`base_branch` from the slot and pass them through to worktree creation

Option 1 is cleaner — if someone is using `--matrix`, they want the full matrix behavior.

## Testing

- Unit test: single-entry matrix with `branch` field → verify worktree is created
- Unit test: single-entry matrix without `branch` → verify it still works (uses cwd)
- Check existing multi-entry matrix tests still pass
- Run `agentctl launch --help` to verify no flag conflicts

## COMMIT AND PUSH before finishing.
