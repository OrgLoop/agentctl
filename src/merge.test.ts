import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeSession } from "./merge.js";

const execFileAsync = promisify(execFile);

let tmpDir: string;
let repoDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-merge-test-"));
  repoDir = path.join(tmpDir, "repo");
  await fs.mkdir(repoDir, { recursive: true });

  // Initialize a git repo with a commit
  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], {
    cwd: repoDir,
  });
  await execFileAsync("git", ["config", "user.name", "Test"], {
    cwd: repoDir,
  });
  await fs.writeFile(path.join(repoDir, "README.md"), "# Test");
  await execFileAsync("git", ["add", "."], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("mergeSession", () => {
  it("commits uncommitted changes", async () => {
    // Create an unstaged change
    await fs.writeFile(path.join(repoDir, "new-file.txt"), "new content");

    const result = await mergeSession({ cwd: repoDir });

    expect(result.committed).toBe(true);

    // Verify the commit was made
    const { stdout } = await execFileAsync("git", ["log", "--oneline", "-1"], {
      cwd: repoDir,
    });
    expect(stdout).toContain("agentctl merge");
  });

  it("uses custom commit message", async () => {
    await fs.writeFile(path.join(repoDir, "change.txt"), "custom msg test");

    const result = await mergeSession({
      cwd: repoDir,
      message: "feat: custom message",
    });

    expect(result.committed).toBe(true);

    const { stdout } = await execFileAsync("git", ["log", "--oneline", "-1"], {
      cwd: repoDir,
    });
    expect(stdout).toContain("custom message");
  });

  it("reports no changes when nothing to commit", async () => {
    // No changes made
    const result = await mergeSession({ cwd: repoDir });

    expect(result.committed).toBe(false);
    // Push will fail since there's no remote, but committed should be false
  });

  it("handles push failure gracefully", async () => {
    // Create a change but no remote configured
    await fs.writeFile(path.join(repoDir, "fail-push.txt"), "will fail push");

    const result = await mergeSession({ cwd: repoDir });

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false); // No remote configured
  });
});
