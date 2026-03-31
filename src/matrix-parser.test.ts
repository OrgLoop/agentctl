import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandMatrix,
  expandTildePath,
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

  it("allows missing prompt (CLI -p can provide it)", async () => {
    const filePath = path.join(tmpDir, "no-prompt.yaml");
    await fs.writeFile(
      filePath,
      `
matrix:
  - adapter: claude-code
`,
    );

    const result = await parseMatrixFile(filePath);
    expect(result.prompt).toBeUndefined();
    expect(result.matrix).toHaveLength(1);
  });

  it("throws on non-string prompt", async () => {
    const filePath = path.join(tmpDir, "bad.yaml");
    await fs.writeFile(
      filePath,
      `
prompt: 123
matrix:
  - adapter: claude-code
`,
    );

    await expect(parseMatrixFile(filePath)).rejects.toThrow(
      "'prompt' field must be a string",
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

describe("expandTildePath", () => {
  it("expands ~/path to homedir/path", () => {
    const result = expandTildePath("~/code/mono");
    expect(result).toBe(path.join(os.homedir(), "code/mono"));
  });

  it("expands bare ~ to homedir", () => {
    const result = expandTildePath("~");
    expect(result).toBe(os.homedir());
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandTildePath("/usr/local/bin")).toBe("/usr/local/bin");
  });

  it("leaves relative paths unchanged", () => {
    expect(expandTildePath("./foo/bar")).toBe("./foo/bar");
  });

  it("does not expand ~ in the middle of a path", () => {
    expect(expandTildePath("/home/~user")).toBe("/home/~user");
  });
});

describe("parseMatrixFile — base_branch", () => {
  it("parses base_branch from matrix entries", async () => {
    const filePath = path.join(tmpDir, "matrix.yaml");
    await fs.writeFile(
      filePath,
      `
prompt: "Implement feature"
matrix:
  - adapter: opencode
    model: ohm/moonshotai/Kimi-K2.5
    branch: auto/ENG-1234-kimi
    base_branch: research/ENG-1234
  - adapter: claude-code
`,
    );

    const result = await parseMatrixFile(filePath);
    expect(result.matrix[0].base_branch).toBe("research/ENG-1234");
    expect(result.matrix[0].branch).toBe("auto/ENG-1234-kimi");
    expect(result.matrix[1].base_branch).toBeUndefined();
    expect(result.matrix[1].branch).toBeUndefined();
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

  it("propagates base_branch to expanded slots", () => {
    const matrix: MatrixFile = {
      prompt: "test",
      matrix: [
        {
          adapter: "opencode",
          model: "kimi",
          branch: "auto/ENG-1234-kimi",
          base_branch: "research/ENG-1234",
        },
        { adapter: "claude-code" },
      ],
    };

    const slots = expandMatrix(matrix);
    expect(slots[0]).toEqual({
      adapter: "opencode",
      model: "kimi",
      branch: "auto/ENG-1234-kimi",
      baseBranch: "research/ENG-1234",
    });
    // Entry without base_branch should not have it
    expect(slots[1]).toEqual({ adapter: "claude-code" });
    expect(slots[1].baseBranch).toBeUndefined();
  });

  it("propagates camelCase baseBranch from matrix YAML", () => {
    const matrix: MatrixFile = {
      prompt: "test",
      matrix: [
        {
          adapter: "opencode",
          model: "kimi",
          branch: "auto/ENG-1234-kimi",
          baseBranch: "research/ENG-1234",
        },
        { adapter: "claude-code" },
      ],
    };

    const slots = expandMatrix(matrix);
    expect(slots[0]).toEqual({
      adapter: "opencode",
      model: "kimi",
      branch: "auto/ENG-1234-kimi",
      baseBranch: "research/ENG-1234",
    });
    expect(slots[1].baseBranch).toBeUndefined();
  });

  it("prefers snake_case base_branch over camelCase baseBranch", () => {
    const matrix: MatrixFile = {
      prompt: "test",
      matrix: [
        {
          adapter: "opencode",
          base_branch: "research/from-snake",
          baseBranch: "research/from-camel",
        },
      ],
    };

    const slots = expandMatrix(matrix);
    expect(slots[0].baseBranch).toBe("research/from-snake");
  });

  it("propagates base_branch across array model expansion", () => {
    const matrix: MatrixFile = {
      prompt: "test",
      matrix: [
        {
          adapter: "claude-code",
          model: ["opus", "sonnet"],
          base_branch: "research/ENG-1234",
        },
      ],
    };

    const slots = expandMatrix(matrix);
    expect(slots).toHaveLength(2);
    expect(slots[0].baseBranch).toBe("research/ENG-1234");
    expect(slots[1].baseBranch).toBe("research/ENG-1234");
  });
});
