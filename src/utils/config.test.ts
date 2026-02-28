import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-config-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns empty object when config file does not exist", async () => {
    const config = await loadConfig(path.join(tmpDir, "nope.json"));
    expect(config).toEqual({});
  });

  it("parses valid config JSON", async () => {
    const configPath = path.join(tmpDir, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ model: "opus", adapter: "claude-code", timeout: 300 }),
    );

    const config = await loadConfig(configPath);
    expect(config.model).toBe("opus");
    expect(config.adapter).toBe("claude-code");
    expect(config.timeout).toBe(300);
  });

  it("returns empty object for malformed JSON", async () => {
    const configPath = path.join(tmpDir, "config.json");
    await fs.writeFile(configPath, "not valid json{{{");

    const config = await loadConfig(configPath);
    expect(config).toEqual({});
  });

  it("returns empty object for non-object JSON (array)", async () => {
    const configPath = path.join(tmpDir, "config.json");
    await fs.writeFile(configPath, "[1, 2, 3]");

    const config = await loadConfig(configPath);
    expect(config).toEqual({});
  });
});
