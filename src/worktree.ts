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

/** Info about an existing worktree from `git worktree list` */
export interface WorktreeListEntry {
  path: string;
  branch: string;
  head: string;
  /** Whether this is the bare/main worktree */
  bare: boolean;
}

/**
 * List all git worktrees for a repo.
 * Parses `git worktree list --porcelain` output.
 */
export async function listWorktrees(
  repo: string,
): Promise<WorktreeListEntry[]> {
  const repoResolved = path.resolve(repo);
  const { stdout } = await execFileAsync(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd: repoResolved },
  );

  const entries: WorktreeListEntry[] = [];
  let current: Partial<WorktreeListEntry> = {};

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) entries.push(current as WorktreeListEntry);
      current = { path: line.replace("worktree ", ""), bare: false };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.replace("HEAD ", "");
    } else if (line.startsWith("branch ")) {
      current.branch = line.replace("branch refs/heads/", "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "" && current.path) {
      // End of entry
    }
  }

  if (current.path) entries.push(current as WorktreeListEntry);

  return entries;
}

/**
 * Remove a worktree and optionally delete its branch.
 */
export async function cleanWorktree(
  repo: string,
  worktreePath: string,
  opts?: { deleteBranch?: boolean },
): Promise<{ removedPath: string; deletedBranch?: string }> {
  const repoResolved = path.resolve(repo);

  // Get the branch name before removing
  let branch: string | undefined;
  if (opts?.deleteBranch) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: worktreePath },
      );
      branch = stdout.trim();
    } catch {
      // Worktree might be broken — still try to remove
    }
  }

  await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repoResolved,
  });

  const result: { removedPath: string; deletedBranch?: string } = {
    removedPath: worktreePath,
  };

  // Delete the branch if requested
  if (branch && opts?.deleteBranch) {
    try {
      await execFileAsync("git", ["branch", "-D", branch], {
        cwd: repoResolved,
      });
      result.deletedBranch = branch;
    } catch {
      // Branch might already be gone
    }
  }

  return result;
}
