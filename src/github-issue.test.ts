import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock execFile at the module level before importing the module under test.
// We must wire up promisify.custom so that promisify(execFileMock) resolves
// { stdout, stderr } (not just the first callback arg, which is the default
// when the custom symbol is absent).
vi.mock("node:child_process", () => {
  const execFileMock = vi.fn();

  // Symbol.for matches the key util.promisify.custom uses internally
  const CUSTOM = Symbol.for("nodejs.util.promisify.custom");
  (execFileMock as unknown as Record<symbol, unknown>)[CUSTOM] = (
    ...outerArgs: unknown[]
  ) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFileMock(
        ...outerArgs,
        (err: Error | null, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        },
      );
    });

  return { execFile: execFileMock };
});

import { execFile } from "node:child_process";
import { fetchIssue, formatIssuePrompt, inferRepo } from "./github-issue.js";

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

/** Mock execFile to call the callback (last arg) with the given result. */
function mockSuccess(stdout: string, stderr = "") {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
    (...args: unknown[]) => {
      const cb = args.at(-1) as ExecCallback;
      cb(null, stdout, stderr);
    },
  );
}

function mockFailure(error: Error & { stderr?: string }) {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
    (...args: unknown[]) => {
      const cb = args.at(-1) as ExecCallback;
      cb(error, "", error.stderr ?? "");
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── inferRepo ───────────────────────────────────────────────────────────────

describe("inferRepo", () => {
  it("parses SSH remote URL", async () => {
    mockSuccess("git@github.com:owner/myrepo.git\n");
    expect(await inferRepo("/some/cwd")).toBe("owner/myrepo");
  });

  it("parses SSH remote URL without .git suffix", async () => {
    mockSuccess("git@github.com:owner/myrepo\n");
    expect(await inferRepo("/some/cwd")).toBe("owner/myrepo");
  });

  it("parses HTTPS remote URL with .git suffix", async () => {
    mockSuccess("https://github.com/owner/myrepo.git\n");
    expect(await inferRepo("/some/cwd")).toBe("owner/myrepo");
  });

  it("parses HTTPS remote URL without .git suffix", async () => {
    mockSuccess("https://github.com/owner/myrepo\n");
    expect(await inferRepo("/some/cwd")).toBe("owner/myrepo");
  });

  it("throws if no origin remote", async () => {
    mockFailure(
      Object.assign(new Error("fatal: No such remote 'origin'"), {
        stderr: "fatal: No such remote 'origin'",
      }),
    );
    await expect(inferRepo("/some/cwd")).rejects.toThrow(
      "no 'origin' remote found",
    );
  });

  it("throws if URL is not a GitHub URL", async () => {
    mockSuccess("https://gitlab.com/owner/repo.git\n");
    await expect(inferRepo("/some/cwd")).rejects.toThrow(
      "Could not parse owner/repo from remote URL",
    );
  });

  it("invokes git remote get-url origin with the given cwd", async () => {
    mockSuccess("git@github.com:org/proj.git\n");
    await inferRepo("/my/project");
    const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("git");
    expect(calls[0][1]).toEqual(["remote", "get-url", "origin"]);
    expect(calls[0][2]).toMatchObject({ cwd: "/my/project" });
  });
});

// ─── fetchIssue ──────────────────────────────────────────────────────────────

describe("fetchIssue", () => {
  it("returns title and body on success", async () => {
    mockSuccess(
      JSON.stringify({ title: "Fix the thing", body: "The thing is broken." }),
    );
    const issue = await fetchIssue(42, "owner/repo");
    expect(issue.title).toBe("Fix the thing");
    expect(issue.body).toBe("The thing is broken.");
  });

  it("returns empty body when issue has no body", async () => {
    mockSuccess(JSON.stringify({ title: "No body issue", body: "" }));
    const issue = await fetchIssue(1, "owner/repo");
    expect(issue.body).toBe("");
  });

  it("throws with clear message if gh fails", async () => {
    mockFailure(
      Object.assign(new Error("gh: not found"), {
        stderr: "Could not resolve to an Issue",
      }),
    );
    await expect(fetchIssue(99, "owner/repo")).rejects.toThrow(
      "Failed to fetch issue #99 from owner/repo",
    );
  });

  it("throws if JSON is invalid", async () => {
    mockSuccess("not json");
    await expect(fetchIssue(1, "owner/repo")).rejects.toThrow(
      "Failed to parse gh output",
    );
  });

  it("calls gh with correct arguments", async () => {
    mockSuccess(JSON.stringify({ title: "T", body: "B" }));
    await fetchIssue(12, "myorg/myrepo");
    const calls = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("gh");
    expect(calls[0][1]).toEqual([
      "issue",
      "view",
      "12",
      "--repo",
      "myorg/myrepo",
      "--json",
      "title,body",
    ]);
  });
});

// ─── formatIssuePrompt ───────────────────────────────────────────────────────

describe("formatIssuePrompt", () => {
  it("formats issue with body and appends prompt", () => {
    const result = formatIssuePrompt(
      { title: "Fix the bug", body: "Steps to reproduce:\n1. Do X\n2. Crash" },
      12,
      "Implement this issue. COMMIT AND PUSH before finishing.",
    );
    expect(result).toBe(
      [
        "## GitHub Issue #12: Fix the bug",
        "",
        "Steps to reproduce:\n1. Do X\n2. Crash",
        "",
        "---",
        "",
        "Implement this issue. COMMIT AND PUSH before finishing.",
      ].join("\n"),
    );
  });

  it("omits body section when body is empty", () => {
    const result = formatIssuePrompt(
      { title: "Empty body issue", body: "" },
      5,
      "Do the thing.",
    );
    expect(result).toBe(
      [
        "## GitHub Issue #5: Empty body issue",
        "",
        "---",
        "",
        "Do the thing.",
      ].join("\n"),
    );
  });

  it("omits body section when body is only whitespace", () => {
    const result = formatIssuePrompt(
      { title: "Whitespace body", body: "   \n  " },
      3,
      "prompt",
    );
    expect(result).not.toContain("   \n  ");
    expect(result).toContain("## GitHub Issue #3: Whitespace body");
    expect(result).toContain("prompt");
  });
});
