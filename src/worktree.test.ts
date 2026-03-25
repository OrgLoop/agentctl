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
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-wt-test-"));
  repoDir = path.join(tmpDir, "repo");
  await fs.mkdir(repoDir, { recursive: true });

  // Sanitize process.env so ALL git subprocesses (including those spawned
  // by source-code functions like createWorktree) are isolated from any
  // parent repo. This is critical when tests run inside a pre-push hook,
  // where GIT_DIR leaks and causes git commands to operate on the wrong repo.
  savedEnv = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
  };
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  process.env.GIT_CEILING_DIRECTORIES = tmpDir;

  // Initialize a git repo with a commit
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], {
    cwd: repoDir,
  });
  await execFileAsync("git", ["config", "user.name", "Test"], {
    cwd: repoDir,
  });
  await fs.writeFile(path.join(repoDir, "README.md"), "# Test repo");
  await execFileAsync("git", ["add", "."], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoDir });
});

afterEach(async () => {
  // Clean up worktrees before removing tmpDir
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: repoDir },
    );
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ") && !line.includes(repoDir)) {
        const wtPath = line.replace("worktree ", "");
        try {
          await execFileAsync(
            "git",
            ["worktree", "remove", "--force", wtPath],
            { cwd: repoDir },
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

  // Restore original env
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
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
      { cwd: result.path },
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

describe("createWorktree — baseBranch", () => {
  let remoteDir: string;

  beforeEach(async () => {
    // Create a bare remote repo and push initial commit
    remoteDir = path.join(tmpDir, "remote.git");
    await execFileAsync("git", ["clone", "--bare", repoDir, remoteDir]);
    // Add the remote to our working repo
    await execFileAsync("git", ["remote", "add", "origin", remoteDir], {
      cwd: repoDir,
    });
    // Determine the default branch name and push it
    const { stdout: branchOut } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoDir },
    );
    const defaultBranch = branchOut.trim();
    await execFileAsync("git", ["push", "origin", defaultBranch], {
      cwd: repoDir,
    });
  });

  it("creates worktree from a specified base branch", async () => {
    // Create a base branch with unique content and push it
    await execFileAsync("git", ["checkout", "-b", "research/ENG-1234"], {
      cwd: repoDir,
    });
    await fs.writeFile(
      path.join(repoDir, "spec.md"),
      "# Research spec artifact",
    );
    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-m", "add spec"], { cwd: repoDir });
    await execFileAsync("git", ["push", "origin", "research/ENG-1234"], {
      cwd: repoDir,
    });
    // Go back to the default branch so the worktree isn't on the base branch
    await execFileAsync("git", ["checkout", "-"], { cwd: repoDir });

    const result = await createWorktree({
      repo: repoDir,
      branch: "auto/ENG-1234-kimi",
      baseBranch: "research/ENG-1234",
    });

    expect(result.branch).toBe("auto/ENG-1234-kimi");

    // The worktree should contain the file from the base branch
    const specContent = await fs.readFile(
      path.join(result.path, "spec.md"),
      "utf-8",
    );
    expect(specContent).toBe("# Research spec artifact");
  });

  it("falls back to HEAD when baseBranch is not specified", async () => {
    const result = await createWorktree({
      repo: repoDir,
      branch: "feature/no-base",
    });

    expect(result.branch).toBe("feature/no-base");
    // Should not contain spec.md (only README.md from initial commit)
    const files = await fs.readdir(result.path);
    expect(files).toContain("README.md");
    expect(files).not.toContain("spec.md");
  });

  it("throws a clear error for invalid base branch", async () => {
    await expect(
      createWorktree({
        repo: repoDir,
        branch: "feature/bad-base",
        baseBranch: "nonexistent/branch",
      }),
    ).rejects.toThrow("Failed to fetch base branch: origin/nonexistent/branch");
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
