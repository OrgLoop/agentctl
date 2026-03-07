import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { buildSpawnEnv, getCommonBinDirs } from "./daemon-env.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = execFileSync as Mock;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getCommonBinDirs", () => {
  it("returns an array of common bin directories", () => {
    const dirs = getCommonBinDirs();
    expect(dirs).toBeInstanceOf(Array);
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs).toContain("/usr/local/bin");
    expect(dirs).toContain("/usr/bin");
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs.some((d) => d.includes(".cargo/bin"))).toBe(true);
  });
});

describe("buildSpawnEnv", () => {
  it("sources ~/.zshenv and returns env with augmented PATH", () => {
    const fakeEnv = `HOME=/Users/test\0PATH=/usr/bin:/bin\0EDITOR=vim\0`;
    mockedExecFileSync.mockReturnValue(fakeEnv);

    const env = buildSpawnEnv();

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-c", expect.stringContaining("source")],
      expect.objectContaining({ encoding: "utf-8", timeout: 5000 }),
    );
    expect(env.HOME).toBe("/Users/test");
    expect(env.EDITOR).toBe("vim");
    // PATH should include original dirs + common bin dirs
    expect(env.PATH).toContain("/usr/bin");
    expect(env.PATH).toContain("/opt/homebrew/bin");
  });

  it("falls back to process.env when sourcing fails", () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("zsh not found");
    });

    const env = buildSpawnEnv();

    // Should still have process.env PATH augmented with common dirs
    expect(env.PATH).toBeDefined();
    expect(env.PATH).toContain("/opt/homebrew/bin");
  });

  it("applies extra env overrides", () => {
    const fakeEnv = `HOME=/Users/test\0PATH=/usr/bin\0`;
    mockedExecFileSync.mockReturnValue(fakeEnv);

    const env = buildSpawnEnv({ MY_VAR: "hello", PATH: "/custom/bin" });

    expect(env.MY_VAR).toBe("hello");
    // Extra env PATH override should win
    expect(env.PATH).toBe("/custom/bin");
  });

  it("does not duplicate existing PATH entries", () => {
    const home = os.homedir();
    const cargoDir = path.join(home, ".cargo", "bin");
    const fakeEnv = `PATH=/usr/bin:${cargoDir}\0`;
    mockedExecFileSync.mockReturnValue(fakeEnv);

    const env = buildSpawnEnv();

    // Count occurrences of cargoDir in PATH
    const pathDirs = (env.PATH ?? "").split(":");
    const count = pathDirs.filter((d) => d === cargoDir).length;
    expect(count).toBe(1);
  });

  it("handles empty output from zsh gracefully", () => {
    mockedExecFileSync.mockReturnValue("");

    const env = buildSpawnEnv();

    // Should fall back to process.env
    expect(env.PATH).toBeDefined();
  });
});
