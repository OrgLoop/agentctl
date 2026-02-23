import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandMatrix,
  type MatrixFile,
  parseMatrixFile,
} from "./matrix-parser.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-matrix-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("parseMatrixFile", () => {
  it("parses a valid matrix file", async () => {
    const filePath = path.join(tmpDir, "matrix.yaml");
    await fs.writeFile(
      filePath,
      `
prompt: "Implement the caching layer"
cwd: ~/code/mono
matrix:
  - adapter: claude-code
    model: claude-opus-4-6
  - adapter: codex
`,
    );

    const result = await parseMatrixFile(filePath);
    expect(result.prompt).toBe("Implement the caching layer");
    expect(result.cwd).toBe("~/code/mono");
    expect(result.matrix).toHaveLength(2);
    expect(result.matrix[0].adapter).toBe("claude-code");
    expect(result.matrix[0].model).toBe("claude-opus-4-6");
    expect(result.matrix[1].adapter).toBe("codex");
  });

  it("parses matrix with array model values", async () => {
    const filePath = path.join(tmpDir, "matrix.yaml");
    await fs.writeFile(
      filePath,
      `
prompt: "Refactor auth"
matrix:
  - adapter: claude-code
    model:
      - claude-opus-4-6
      - claude-sonnet-4-5
  - adapter: codex
`,
    );

    const result = await parseMatrixFile(filePath);
    expect(result.matrix[0].model).toEqual([
      "claude-opus-4-6",
      "claude-sonnet-4-5",
    ]);
  });

  it("throws on missing prompt", async () => {
    const filePath = path.join(tmpDir, "bad.yaml");
    await fs.writeFile(
      filePath,
      `
matrix:
  - adapter: claude-code
`,
    );

    await expect(parseMatrixFile(filePath)).rejects.toThrow(
      "must have a 'prompt' field",
    );
  });

  it("throws on empty matrix", async () => {
    const filePath = path.join(tmpDir, "bad.yaml");
    await fs.writeFile(
      filePath,
      `
prompt: "test"
matrix: []
`,
    );

    await expect(parseMatrixFile(filePath)).rejects.toThrow(
      "non-empty 'matrix' array",
    );
  });

  it("throws on missing adapter in entry", async () => {
    const filePath = path.join(tmpDir, "bad.yaml");
    await fs.writeFile(
      filePath,
      `
prompt: "test"
matrix:
  - model: opus
`,
    );

    await expect(parseMatrixFile(filePath)).rejects.toThrow(
      "must have an 'adapter' field",
    );
  });

  it("throws on non-existent file", async () => {
    await expect(
      parseMatrixFile(path.join(tmpDir, "nope.yaml")),
    ).rejects.toThrow();
  });
});

describe("expandMatrix", () => {
  it("expands simple entries to single slots", () => {
    const matrix: MatrixFile = {
      prompt: "test",
      matrix: [{ adapter: "claude-code", model: "opus" }, { adapter: "codex" }],
    };

    const slots = expandMatrix(matrix);
    expect(slots).toEqual([
      { adapter: "claude-code", model: "opus" },
      { adapter: "codex" },
    ]);
  });

  it("expands array model values into multiple slots", () => {
    const matrix: MatrixFile = {
      prompt: "test",
      matrix: [
        { adapter: "claude-code", model: ["opus", "sonnet"] },
        { adapter: "codex" },
      ],
    };

    const slots = expandMatrix(matrix);
    expect(slots).toEqual([
      { adapter: "claude-code", model: "opus" },
      { adapter: "claude-code", model: "sonnet" },
      { adapter: "codex" },
    ]);
  });

  it("handles entries with no model", () => {
    const matrix: MatrixFile = {
      prompt: "test",
      matrix: [{ adapter: "pi" }],
    };

    const slots = expandMatrix(matrix);
    expect(slots).toEqual([{ adapter: "pi" }]);
  });

  it("handles complex cross-product", () => {
    const matrix: MatrixFile = {
      prompt: "test",
      matrix: [
        { adapter: "claude-code", model: ["opus", "sonnet", "haiku"] },
        { adapter: "codex", model: ["gpt-5", "gpt-4o"] },
        { adapter: "pi" },
      ],
    };

    const slots = expandMatrix(matrix);
    expect(slots).toHaveLength(6); // 3 + 2 + 1
    expect(slots[0]).toEqual({ adapter: "claude-code", model: "opus" });
    expect(slots[3]).toEqual({ adapter: "codex", model: "gpt-5" });
    expect(slots[5]).toEqual({ adapter: "pi" });
  });
});
