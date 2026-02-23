import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readHead, readTail } from "./partial-read.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "partial-read-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function filePath(name: string): string {
  return path.join(tmpDir, name);
}

describe("readHead", () => {
  it("reads first N lines from a small file", async () => {
    const fp = filePath("small.jsonl");
    await fs.writeFile(fp, "line1\nline2\nline3\nline4\nline5\n");

    const lines = await readHead(fp, 3);
    expect(lines).toEqual(["line1", "line2", "line3"]);
  });

  it("returns all lines when file has fewer than maxLines", async () => {
    const fp = filePath("short.jsonl");
    await fs.writeFile(fp, "a\nb\n");

    const lines = await readHead(fp, 10);
    expect(lines).toEqual(["a", "b"]);
  });

  it("returns empty array for empty file", async () => {
    const fp = filePath("empty.jsonl");
    await fs.writeFile(fp, "");

    const lines = await readHead(fp, 5);
    expect(lines).toEqual([]);
  });

  it("handles file with no trailing newline", async () => {
    const fp = filePath("notail.jsonl");
    await fs.writeFile(fp, "only-line");

    const lines = await readHead(fp, 5);
    expect(lines).toEqual(["only-line"]);
  });

  it("truncates at maxBytes and drops partial last line", async () => {
    const fp = filePath("large.jsonl");
    // Each line is 10 chars + newline = 11 bytes
    const content = `${Array.from(
      { length: 100 },
      (_, i) => `line-${String(i).padStart(4, "0")}`,
    ).join("\n")}\n`;
    await fs.writeFile(fp, content);

    // Read only 55 bytes — should get 5 complete lines (each ~10 chars + newline)
    const lines = await readHead(fp, 100, 55);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines[0]).toBe("line-0000");
    // All returned lines should be complete
    for (const l of lines) {
      expect(l).toMatch(/^line-\d{4}$/);
    }
  });

  it("works with JSON lines", async () => {
    const fp = filePath("json.jsonl");
    const jsonLines = [
      JSON.stringify({
        type: "user",
        cwd: "/test",
        message: { content: "hello" },
      }),
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-opus-4-6" },
      }),
      JSON.stringify({ type: "user", message: { content: "world" } }),
    ];
    await fs.writeFile(fp, `${jsonLines.join("\n")}\n`);

    const lines = await readHead(fp, 2, 8192);
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.cwd).toBe("/test");
  });
});

describe("readTail", () => {
  it("reads last N lines from a small file", async () => {
    const fp = filePath("small-tail.jsonl");
    await fs.writeFile(fp, "line1\nline2\nline3\nline4\nline5\n");

    const lines = await readTail(fp, 3);
    expect(lines).toEqual(["line3", "line4", "line5"]);
  });

  it("returns all lines when file has fewer than maxLines", async () => {
    const fp = filePath("short-tail.jsonl");
    await fs.writeFile(fp, "a\nb\n");

    const lines = await readTail(fp, 10);
    expect(lines).toEqual(["a", "b"]);
  });

  it("returns empty array for empty file", async () => {
    const fp = filePath("empty-tail.jsonl");
    await fs.writeFile(fp, "");

    const lines = await readTail(fp, 5);
    expect(lines).toEqual([]);
  });

  it("handles file smaller than maxBytes", async () => {
    const fp = filePath("tiny.jsonl");
    await fs.writeFile(fp, "one\ntwo\nthree\n");

    // maxBytes larger than file
    const lines = await readTail(fp, 100, 1_000_000);
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it("reads only from the end of a large file", async () => {
    const fp = filePath("large-tail.jsonl");
    // Create a file where the last 100 bytes contain the tail
    const manyLines = Array.from(
      { length: 1000 },
      (_, i) => `line-${String(i).padStart(4, "0")}`,
    );
    await fs.writeFile(fp, `${manyLines.join("\n")}\n`);

    // Read last 100 bytes — should get only a few lines from the end
    const lines = await readTail(fp, 100, 100);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(20);
    // Last line should be the final line
    expect(lines[lines.length - 1]).toBe("line-0999");
    // First line should NOT be the first line of the file
    expect(lines[0]).not.toBe("line-0000");
  });

  it("drops partial first line when reading from middle of file", async () => {
    const fp = filePath("partial-first.jsonl");
    const manyLines = Array.from(
      { length: 200 },
      (_, i) => `line-${String(i).padStart(4, "0")}`,
    );
    await fs.writeFile(fp, `${manyLines.join("\n")}\n`);

    // Read a small chunk — first line will be partial, should be dropped
    const lines = await readTail(fp, 100, 60);
    for (const l of lines) {
      expect(l).toMatch(/^line-\d{4}$/);
    }
  });

  it("works with JSON lines for token aggregation", async () => {
    const fp = filePath("json-tail.jsonl");
    const messages = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          content: [{ type: "text", text: `Response ${i}` }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    );
    await fs.writeFile(fp, `${messages.join("\n")}\n`);

    const lines = await readTail(fp, 10);
    expect(lines).toHaveLength(10);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.message.model).toBe("claude-opus-4-6");
    expect(last.message.usage.input_tokens).toBe(100);
  });

  it("handles file with no trailing newline", async () => {
    const fp = filePath("notail-tail.jsonl");
    await fs.writeFile(fp, "first\nsecond\nthird");

    const lines = await readTail(fp, 2);
    expect(lines).toEqual(["second", "third"]);
  });
});
