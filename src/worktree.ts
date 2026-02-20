import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeCreateOpts {
  /** Path to the main repo (e.g. ~/code/myproject) */
  repo: string;
  /** Branch name (e.g. charlie/feature-name) */
  branch: string;
}

export interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  path: string;
  /** Branch name */
  branch: string;
  /** The base repo path */
  repo: string;
}

/**
 * Create a git worktree for the given repo + branch.
 * Worktree is placed at `<repo>-<branch-slug>` (sibling directory).
 * If the worktree already exists, returns its info without creating a new one.
 */
export async function createWorktree(
  opts: WorktreeCreateOpts,
): Promise<WorktreeInfo> {
  const repoResolved = path.resolve(opts.repo);
  const slug = opts.branch.replace(/\//g, "-");
  const worktreePath = `${repoResolved}-${slug}`;

  // Check if worktree already exists (check filesystem + git)
  try {
    // Quick filesystem check — if the .git file exists in the worktree dir, it's a worktree
    const gitFile = path.join(worktreePath, ".git");
    try {
      await fs.access(gitFile);
      return { path: worktreePath, branch: opts.branch, repo: repoResolved };
    } catch {
      // Not on disk yet — check git's worktree list (handles symlink/realpath differences)
    }

    // Validate this is actually a git repo
    await execFileAsync("git", ["rev-parse", "--git-dir"], {
      cwd: repoResolved,
    });
  } catch {
    throw new Error(`Not a git repository: ${repoResolved}`);
  }

  // Check if branch already exists
  let branchExists = false;
  try {
    await execFileAsync("git", ["rev-parse", "--verify", opts.branch], {
      cwd: repoResolved,
    });
    branchExists = true;
  } catch {
    // Branch doesn't exist yet
  }

  if (branchExists) {
    // Branch exists — create worktree checking it out
    await execFileAsync("git", ["worktree", "add", worktreePath, opts.branch], {
      cwd: repoResolved,
    });
  } else {
    // Branch doesn't exist — create new branch from HEAD
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", opts.branch, worktreePath],
      { cwd: repoResolved },
    );
  }

  return { path: worktreePath, branch: opts.branch, repo: repoResolved };
}

/**
 * Remove a git worktree.
 */
export async function removeWorktree(
  repo: string,
  worktreePath: string,
): Promise<void> {
  const repoResolved = path.resolve(repo);
  await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoResolved,
  });
}
