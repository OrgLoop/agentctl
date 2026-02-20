import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, removeWorktree } from "./worktree.js";

const execFileAsync = promisify(execFile);

let tmpDir: string;
let repoDir: string;
let gitEnv: Record<string, string>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-wt-test-"));
  repoDir = path.join(tmpDir, "repo");
  await fs.mkdir(repoDir, { recursive: true });

  // Prevent git from discovering parent repos (critical during pre-push hooks)
  gitEnv = { ...process.env, GIT_CEILING_DIRECTORIES: tmpDir } as Record<
    string,
    string
  >;

  // Initialize a git repo with a commit
  await execFileAsync("git", ["init"], { cwd: repoDir, env: gitEnv });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], {
    cwd: repoDir,
    env: gitEnv,
  });
  await execFileAsync("git", ["config", "user.name", "Test"], {
    cwd: repoDir,
    env: gitEnv,
  });
  await fs.writeFile(path.join(repoDir, "README.md"), "# Test repo");
  await execFileAsync("git", ["add", "."], { cwd: repoDir, env: gitEnv });
  await execFileAsync("git", ["commit", "-m", "initial"], {
    cwd: repoDir,
    env: gitEnv,
  });
});

afterEach(async () => {
  // Clean up worktrees before removing tmpDir
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: repoDir, env: gitEnv },
    );
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ") && !line.includes(repoDir)) {
        const wtPath = line.replace("worktree ", "");
        try {
          await execFileAsync(
            "git",
            ["worktree", "remove", "--force", wtPath],
            { cwd: repoDir, env: gitEnv },
          );
        } catch {
          // best effort
        }
      }
    }
  } catch {
    // best effort
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("createWorktree", () => {
  it("creates a worktree with a new branch", async () => {
    const result = await createWorktree({
      repo: repoDir,
      branch: "feature/test-branch",
    });

    expect(result.path).toBe(`${repoDir}-feature-test-branch`);
    expect(result.branch).toBe("feature/test-branch");
    expect(result.repo).toBe(repoDir);

    // Verify the worktree directory exists
    const stat = await fs.stat(result.path);
    expect(stat.isDirectory()).toBe(true);

    // Verify it's on the right branch
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: result.path, env: gitEnv },
    );
    expect(stdout.trim()).toBe("feature/test-branch");
  });

  it("reuses existing worktree if already created", async () => {
    const first = await createWorktree({
      repo: repoDir,
      branch: "reuse-branch",
    });

    const second = await createWorktree({
      repo: repoDir,
      branch: "reuse-branch",
    });

    expect(second.path).toBe(first.path);
  });

  it("throws for non-git directory", async () => {
    const nonGitDir = path.join(tmpDir, "not-a-repo");
    await fs.mkdir(nonGitDir, { recursive: true });

    await expect(
      createWorktree({ repo: nonGitDir, branch: "test" }),
    ).rejects.toThrow("Not a git repository");
  });
});

describe("removeWorktree", () => {
  it("removes a worktree", async () => {
    const wt = await createWorktree({
      repo: repoDir,
      branch: "removable-branch",
    });

    await removeWorktree(repoDir, wt.path);

    // Verify the worktree directory is gone
    await expect(fs.stat(wt.path)).rejects.toThrow();
  });
});
