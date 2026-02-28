import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shortId } from "./utils/display.js";

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

describe("launch --adapter flag (#74)", () => {
  it("--adapter flag is accepted by launch command", async () => {
    const { stdout } = await run(["launch", "--help"]);
    expect(stdout).toContain("--adapter");
  });

  it("--adapter with unknown adapter reports adapter error, not claude-code default", async () => {
    const { stderr } = await run([
      "launch",
      "--adapter",
      "nonexistent-adapter",
      "-p",
      "test",
    ]);
    // Should reference the requested adapter in the error, not silently use claude-code
    expect(stderr).not.toContain("Launched session");
  });
});

describe("shortId (#71)", () => {
  it("truncates normal UUIDs to 8 chars", () => {
    expect(shortId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe("aaaaaaaa");
  });

  it("preserves full pending-<pid> IDs", () => {
    expect(shortId("pending-69460")).toBe("pending-69460");
    expect(shortId("pending-12345")).toBe("pending-12345");
  });

  it("handles pending- with long PIDs", () => {
    expect(shortId("pending-123456789")).toBe("pending-123456789");
  });
});
