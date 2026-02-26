import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";

function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      { env: { ...process.env, AGENTCTL_NO_DAEMON: "1" }, timeout: 10_000 },
      (_err, stdout, stderr) => {
        // commander exits 0 for --help; treat non-zero as content too
        resolve({ stdout, stderr });
      },
    );
  });
}

describe("CLI logs command", () => {
  it("appears in top-level --help", async () => {
    const { stdout } = await run(["--help"]);
    expect(stdout).toContain("logs");
    expect(stdout).toContain("peek");
  });

  it("logs --help shows default 50 lines", async () => {
    const { stdout } = await run(["logs", "--help"]);
    expect(stdout).toContain("50");
    expect(stdout).toContain("--lines");
    expect(stdout).toContain("--adapter");
  });

  it("peek --help shows default 20 lines", async () => {
    const { stdout } = await run(["peek", "--help"]);
    expect(stdout).toContain("20");
    expect(stdout).toContain("--lines");
  });

  it("logs errors on missing session (same as peek)", async () => {
    const { stderr } = await run(["logs", "nonexistent"]);
    expect(stderr).toContain("Session not found");
  });

  it("peek errors on missing session", async () => {
    const { stderr } = await run(["peek", "nonexistent"]);
    expect(stderr).toContain("Session not found");
  });
});
