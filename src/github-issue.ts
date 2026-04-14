import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitHubIssue {
  title: string;
  body: string;
}

/**
 * Infer the GitHub `owner/repo` slug from the git remote of `cwd`.
 * Supports both HTTPS and SSH remote URLs.
 * Throws if no origin remote is found or URL is not a GitHub URL.
 */
export async function inferRepo(cwd: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd,
    }));
  } catch {
    throw new Error(
      "Could not determine GitHub repo: no 'origin' remote found. Use --repo <owner/repo>.",
    );
  }

  const url = stdout.trim();

  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  // HTTPS: https://github.com/owner/repo or https://github.com/owner/repo.git
  const httpsMatch = url.match(
    /github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/)?$/,
  );
  if (httpsMatch) return httpsMatch[1];

  throw new Error(
    `Could not parse owner/repo from remote URL: ${url}. Use --repo <owner/repo>.`,
  );
}

/**
 * Fetch a GitHub issue via `gh issue view`.
 * Throws with a clear error message if the fetch fails.
 */
export async function fetchIssue(
  issueNumber: number,
  repo: string,
): Promise<GitHubIssue> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("gh", [
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "title,body",
    ]));
  } catch (err) {
    const msg =
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr?.trim() ||
      (err as Error).message;
    throw new Error(
      `Failed to fetch issue #${issueNumber} from ${repo}: ${msg}`,
    );
  }

  let parsed: { title?: string; body?: string };
  try {
    parsed = JSON.parse(stdout) as { title?: string; body?: string };
  } catch {
    throw new Error(
      `Failed to parse gh output for issue #${issueNumber}: ${stdout}`,
    );
  }

  if (!parsed.title) {
    throw new Error(`Issue #${issueNumber} not found in ${repo}`);
  }

  return { title: parsed.title, body: parsed.body ?? "" };
}

/**
 * Format a GitHub issue as a prompt prefix and prepend it to the original prompt.
 *
 * Result format:
 * ```
 * ## GitHub Issue #<n>: <title>
 *
 * <body>
 *
 * ---
 *
 * <original prompt>
 * ```
 */
export function formatIssuePrompt(
  issue: GitHubIssue,
  issueNumber: number,
  prompt: string,
): string {
  const header = `## GitHub Issue #${issueNumber}: ${issue.title}`;
  const parts = [header];
  if (issue.body.trim()) {
    parts.push("", issue.body);
  }
  parts.push("", "---", "", prompt);
  return parts.join("\n");
}
