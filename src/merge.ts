import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface MergeOpts {
  /** Working directory of the session */
  cwd: string;
  /** Commit message (auto-generated if omitted) */
  message?: string;
  /** Whether to remove worktree after push */
  removeWorktree?: boolean;
  /** The main repo path (needed for worktree removal) */
  repoPath?: string;
}

export interface MergeResult {
  committed: boolean;
  pushed: boolean;
  prUrl?: string;
  worktreeRemoved: boolean;
}

/**
 * Merge + cleanup workflow:
 * 1. Commit uncommitted changes
 * 2. Push to remote
 * 3. Open PR via `gh`
 * 4. Optionally remove worktree
 */
export async function mergeSession(opts: MergeOpts): Promise<MergeResult> {
  const { cwd } = opts;
  const result: MergeResult = {
    committed: false,
    pushed: false,
    worktreeRemoved: false,
  };

  // 1. Check for uncommitted changes
  const { stdout: status } = await execFileAsync(
    "git",
    ["status", "--porcelain"],
    { cwd },
  );

  if (status.trim()) {
    // Stage all changes and commit
    await execFileAsync("git", ["add", "-A"], { cwd });
    const message =
      opts.message || "chore: commit agent session work (via agentctl merge)";
    await execFileAsync("git", ["commit", "-m", message], { cwd });
    result.committed = true;
  }

  // 2. Get current branch name
  const { stdout: branchRaw } = await execFileAsync(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd },
  );
  const branch = branchRaw.trim();

  // 3. Push to remote
  try {
    await execFileAsync("git", ["push", "-u", "origin", branch], { cwd });
    result.pushed = true;
  } catch (err) {
    console.error("Push failed:", (err as Error).message);
    return result;
  }

  // 4. Open PR via gh (best effort)
  try {
    const { stdout: prOut } = await execAsync(
      `gh pr create --fill --head ${branch} 2>&1 || gh pr view --json url -q .url 2>&1`,
      { cwd },
    );
    // Extract URL from output
    const urlMatch = prOut.match(/https:\/\/github\.com\/[^\s]+/);
    if (urlMatch) {
      result.prUrl = urlMatch[0];
    }
  } catch {
    // gh not available or PR already exists
  }

  // 5. Optionally remove worktree
  if (opts.removeWorktree && opts.repoPath) {
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", cwd], {
        cwd: opts.repoPath,
      });
      result.worktreeRemoved = true;
    } catch (err) {
      console.error("Worktree removal failed:", (err as Error).message);
    }
  }

  return result;
}
