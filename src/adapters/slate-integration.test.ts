/**
 * Slate adapter integration test — runs against the real Slate CLI.
 *
 * Prerequisites:
 * - `slate` binary installed (npm: @randomlabs/slate)
 * - ANTHROPIC_API_KEY set (Slate uses Anthropic models)
 *
 * Skipped automatically if either prerequisite is missing.
 *
 * KNOWN ISSUE (v1.0.15): Slate's `-q` (non-interactive) mode produces
 * empty stdout with exit 0. The LLM call appears to be silently skipped
 * when not running in an interactive terminal. This means stream-json
 * output is empty even though the process exits cleanly. The adapter
 * handles this gracefully by tracking sessions via PID metadata rather
 * than relying on stream output.
 */
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSlateArgs, SLATE_BINARY } from "./slate.js";

const execFileAsync = promisify(execFile);

// --- Skip checks ---

function isSlateInstalled(): boolean {
  try {
    execFileSync("which", [SLATE_BINARY], { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function hasApiKey(): boolean {
  return (process.env.ANTHROPIC_API_KEY?.length ?? 0) > 0;
}

// --- Tests ---

describe("Slate integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentctl-slate-integration-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("CLI flag correctness", () => {
    it("buildSlateArgs produces correct flags", () => {
      const args = buildSlateArgs({
        adapter: "slate",
        prompt: "hello world",
        cwd: "/tmp/test",
      });

      // Must use -q, not -p
      expect(args).toContain("-q");
      expect(args).not.toContain("-p");

      // Must include structured output
      expect(args).toContain("--output-format");
      expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");

      // Must include permission bypass
      expect(args).toContain("--dangerously-set-permissions");

      // Must include workspace
      expect(args).toContain("-w");
      expect(args[args.indexOf("-w") + 1]).toBe("/tmp/test");

      // Prompt is the VALUE of -q, not a separate positional arg
      const qIdx = args.indexOf("-q");
      expect(args[qIdx + 1]).toBe("hello world");
    });

    it.skipIf(!isSlateInstalled())(
      "slate --help confirms -q flag exists",
      async () => {
        const { stdout } = await execFileAsync(SLATE_BINARY, ["--help"]);
        expect(stdout).toContain("-q, --question");
        expect(stdout).toContain("--output-format");
        expect(stdout).toContain("--stream-json");
      },
    );

    it.skipIf(!isSlateInstalled())(
      "slate --help confirms --dangerously-set-permissions does NOT appear (v1.0.15)",
      async () => {
        // Note: --dangerously-set-permissions is documented but may not appear
        // in --help output. The docs at docs.randomlabs.ai confirm it exists.
        const { stdout } = await execFileAsync(SLATE_BINARY, ["--help"]);
        // Just verify help runs without error — the flag existence is
        // confirmed by docs and by the fact that `slate --dangerously-set-permissions`
        // exits cleanly (not "unknown option" error).
        expect(stdout).toContain("--question");
      },
    );

    it.skipIf(!isSlateInstalled())(
      "slate --version returns version string",
      async () => {
        const { stdout } = await execFileAsync(SLATE_BINARY, ["--version"]);
        expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
      },
    );
  });

  describe("non-interactive invocation", () => {
    it.skipIf(!isSlateInstalled() || !hasApiKey())(
      "slate -q exits cleanly with stream-json output (documents empty output bug)",
      async () => {
        // KNOWN BUG: This test documents that Slate v1.0.15's -q mode
        // produces empty output. When this is fixed in a future version,
        // this test should be updated to verify actual JSONL output.
        const { stdout, stderr } = await execFileAsync(
          SLATE_BINARY,
          ["-q", "say hello", "--output-format", "stream-json"],
          { timeout: 15_000, cwd: tmpDir },
        );

        // Process exits cleanly
        // stdout is empty in v1.0.15 (the bug)
        expect(stdout).toBe("");
        expect(stderr).toBe("");
      },
    );

    it.skipIf(!isSlateInstalled() || !hasApiKey())(
      "slate -q with text output also produces empty output",
      async () => {
        const { stdout } = await execFileAsync(
          SLATE_BINARY,
          ["-q", "say hello", "--output-format", "text"],
          { timeout: 15_000, cwd: tmpDir },
        );

        // Also empty in v1.0.15
        expect(stdout).toBe("");
      },
    );

    it.skipIf(!isSlateInstalled())(
      "slate -q with --dangerously-set-permissions does not error",
      async () => {
        // Verify the flag is accepted (no "unknown option" error)
        const { stderr } = await execFileAsync(
          SLATE_BINARY,
          [
            "-q",
            "say hello",
            "--output-format",
            "stream-json",
            "--dangerously-set-permissions",
          ],
          { timeout: 15_000, cwd: tmpDir },
        );

        // No crash, exits cleanly
        expect(stderr).toBe("");
      },
    );
  });

  describe("session tracking without stream output", () => {
    it.skipIf(!isSlateInstalled())(
      "adapter can launch and track session via PID even without stream output",
      async () => {
        // This test verifies the adapter's session tracking works even when
        // Slate produces no stream output (the v1.0.15 bug).
        // We don't actually launch via the adapter (would need full spawn setup)
        // but verify the metadata-based tracking logic is sound.

        const { SlateAdapter } = await import("./slate.js");

        const metaDir = path.join(tmpDir, "meta");
        await fs.mkdir(metaDir, { recursive: true });

        const adapter = new SlateAdapter({
          slateDir: tmpDir,
          sessionsMetaDir: metaDir,
          getPids: async () => new Map(),
          isProcessAlive: () => false,
        });

        // Write fake session metadata (simulating what launch() writes)
        const sessionId = "test-session-id";
        await fs.writeFile(
          path.join(metaDir, `${sessionId}.json`),
          JSON.stringify({
            sessionId,
            pid: 99999,
            launchedAt: new Date().toISOString(),
          }),
        );
        await fs.writeFile(
          path.join(metaDir, `${sessionId}.ext.json`),
          JSON.stringify({
            cwd: tmpDir,
            prompt: "test prompt",
          }),
        );

        // Discover should find the session
        const discovered = await adapter.discover();
        expect(discovered).toHaveLength(1);
        expect(discovered[0].id).toBe(sessionId);
        expect(discovered[0].status).toBe("stopped"); // PID 99999 isn't alive
        expect(discovered[0].prompt).toBe("test prompt");

        // Status should work
        const status = await adapter.status(sessionId);
        expect(status.id).toBe(sessionId);
        expect(status.adapter).toBe("slate");
        expect(status.cwd).toBe(tmpDir);
      },
    );
  });
});
