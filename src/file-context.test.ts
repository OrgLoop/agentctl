import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFileContext,
  formatFileBlock,
  prependToPrompt,
} from "./file-context.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-context-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("formatFileBlock", () => {
  it("wraps content with delimiters", () => {
    const result = formatFileBlock("src/main.ts", "console.log('hi');");
    expect(result).toBe(
      "--- File: src/main.ts ---\nconsole.log('hi');\n--- End File ---",
    );
  });
});

describe("prependToPrompt", () => {
  it("joins prefix and prompt with double newline", () => {
    const result = prependToPrompt("file context", "do the thing");
    expect(result).toBe("file context\n\ndo the thing");
  });
});

describe("buildFileContext", () => {
  it("reads a single file and formats it", async () => {
    await fs.writeFile(path.join(tmpDir, "hello.txt"), "hello world");
    const result = await buildFileContext({
      files: ["hello.txt"],
      cwd: tmpDir,
    });
    expect(result).toBe(
      "--- File: hello.txt ---\nhello world\n--- End File ---",
    );
  });

  it("reads multiple files in order", async () => {
    await fs.writeFile(path.join(tmpDir, "a.txt"), "aaa");
    await fs.writeFile(path.join(tmpDir, "b.txt"), "bbb");
    const result = await buildFileContext({
      files: ["a.txt", "b.txt"],
      cwd: tmpDir,
    });
    expect(result).toContain("--- File: a.txt ---");
    expect(result).toContain("--- File: b.txt ---");
    // a.txt should appear before b.txt
    expect(result.indexOf("a.txt")).toBeLessThan(result.indexOf("b.txt"));
  });

  it("resolves relative paths against cwd", async () => {
    await fs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "sub", "file.txt"), "nested");
    const result = await buildFileContext({
      files: ["sub/file.txt"],
      cwd: tmpDir,
    });
    expect(result).toContain("--- File: sub/file.txt ---");
    expect(result).toContain("nested");
  });

  it("handles absolute paths", async () => {
    const absPath = path.join(tmpDir, "abs.txt");
    await fs.writeFile(absPath, "absolute");
    const result = await buildFileContext({
      files: [absPath],
      cwd: tmpDir,
    });
    expect(result).toContain("abs.txt");
    expect(result).toContain("absolute");
  });

  it("throws on missing file", async () => {
    await expect(
      buildFileContext({ files: ["nonexistent.txt"], cwd: tmpDir }),
    ).rejects.toThrow("File not found: nonexistent.txt");
  });

  it("throws when file exceeds size limit", async () => {
    const bigContent = "x".repeat(1000);
    await fs.writeFile(path.join(tmpDir, "big.txt"), bigContent);
    await expect(
      buildFileContext({
        files: ["big.txt"],
        cwd: tmpDir,
        maxFileSize: 500,
      }),
    ).rejects.toThrow(/exceeds size limit.*big\.txt/);
  });

  it("respects custom maxFileSize", async () => {
    const content = "x".repeat(100);
    await fs.writeFile(path.join(tmpDir, "ok.txt"), content);
    // Should succeed with higher limit
    const result = await buildFileContext({
      files: ["ok.txt"],
      cwd: tmpDir,
      maxFileSize: 200,
    });
    expect(result).toContain("ok.txt");
  });

  it("uses default 50KB limit", async () => {
    // File just under 50KB should work
    const content = "x".repeat(50 * 1024 - 1);
    await fs.writeFile(path.join(tmpDir, "under.txt"), content);
    const result = await buildFileContext({
      files: ["under.txt"],
      cwd: tmpDir,
    });
    expect(result).toContain("under.txt");

    // File over 50KB should fail
    const bigContent = "x".repeat(50 * 1024 + 1);
    await fs.writeFile(path.join(tmpDir, "over.txt"), bigContent);
    await expect(
      buildFileContext({ files: ["over.txt"], cwd: tmpDir }),
    ).rejects.toThrow(/exceeds size limit/);
  });
});

describe("integration: file context + prompt", () => {
  it("produces the expected format with spec + files + prompt", async () => {
    await fs.writeFile(path.join(tmpDir, "spec.md"), "# Spec\nDo X");
    await fs.writeFile(path.join(tmpDir, "ref.ts"), "export const x = 1;");

    const fileContext = await buildFileContext({
      files: ["spec.md", "ref.ts"],
      cwd: tmpDir,
    });
    const finalPrompt = prependToPrompt(fileContext, "implement feature Y");

    expect(finalPrompt).toBe(
      [
        "--- File: spec.md ---",
        "# Spec\nDo X",
        "--- End File ---",
        "",
        "--- File: ref.ts ---",
        "export const x = 1;",
        "--- End File ---",
        "",
        "implement feature Y",
      ].join("\n"),
    );
  });
});
