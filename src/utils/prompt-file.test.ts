import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPromptFile,
  isLargePrompt,
  LARGE_PROMPT_THRESHOLD,
  openPromptFd,
  writePromptFile,
} from "./prompt-file.js";

describe("isLargePrompt", () => {
  it("returns false for small prompts", () => {
    expect(isLargePrompt("hello world")).toBe(false);
  });

  it("returns false for prompts just under threshold", () => {
    const prompt = "x".repeat(LARGE_PROMPT_THRESHOLD - 1);
    expect(isLargePrompt(prompt)).toBe(false);
  });

  it("returns true for prompts exceeding threshold", () => {
    const prompt = "x".repeat(LARGE_PROMPT_THRESHOLD + 1);
    expect(isLargePrompt(prompt)).toBe(true);
  });

  it("measures byte length not character length (multi-byte chars)", () => {
    // Each emoji is 4 bytes in UTF-8
    const charCount = Math.ceil(LARGE_PROMPT_THRESHOLD / 4) + 1;
    const prompt = "\u{1F600}".repeat(charCount);
    expect(prompt.length).toBeLessThan(LARGE_PROMPT_THRESHOLD);
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(LARGE_PROMPT_THRESHOLD);
    expect(isLargePrompt(prompt)).toBe(true);
  });
});

describe("writePromptFile / openPromptFd / cleanupPromptFile", () => {
  let writtenPath: string;

  afterEach(async () => {
    if (writtenPath) {
      await fs.unlink(writtenPath).catch(() => {});
    }
  });

  it("writes prompt to a temp file and reads it back", async () => {
    const prompt = "This is a test prompt with special chars: <>&\"'";
    writtenPath = await writePromptFile(prompt);

    expect(writtenPath).toContain("agentctl");
    expect(writtenPath).toContain("prompt-");

    const content = await fs.readFile(writtenPath, "utf-8");
    expect(content).toBe(prompt);
  });

  it("writes large prompts correctly", async () => {
    const prompt = "A".repeat(200_000);
    writtenPath = await writePromptFile(prompt);

    const content = await fs.readFile(writtenPath, "utf-8");
    expect(content.length).toBe(200_000);
  });

  it("openPromptFd returns a valid file handle", async () => {
    writtenPath = await writePromptFile("test content");
    const fd = await openPromptFd(writtenPath);

    expect(fd.fd).toBeGreaterThanOrEqual(0);
    await fd.close();
  });

  it("cleanupPromptFile removes the file", async () => {
    writtenPath = await writePromptFile("cleanup test");
    await cleanupPromptFile(writtenPath);

    const exists = await fs
      .stat(writtenPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
    writtenPath = ""; // Already cleaned up
  });

  it("cleanupPromptFile is safe on missing files", async () => {
    await expect(
      cleanupPromptFile("/tmp/agentctl/nonexistent-file.txt"),
    ).resolves.toBeUndefined();
  });
});
