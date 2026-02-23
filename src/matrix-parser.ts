import fs from "node:fs/promises";
import YAML from "yaml";
import type { AdapterSlot } from "./launch-orchestrator.js";

// --- Types ---

/** A single entry in the matrix array */
export interface MatrixEntry {
  adapter: string;
  model?: string | string[];
}

/** Top-level matrix file schema */
export interface MatrixFile {
  prompt: string;
  cwd?: string;
  spec?: string;
  hooks?: {
    on_create?: string;
    on_complete?: string;
  };
  matrix: MatrixEntry[];
}

// --- Parsing ---

/**
 * Parse a YAML matrix file and expand into AdapterSlot[].
 *
 * Cross-product expansion: when a matrix entry has an array value for `model`,
 * it expands into one slot per model value.
 *
 * Example:
 *   matrix:
 *     - adapter: claude-code
 *       model: [opus, sonnet]
 *     - adapter: codex
 *
 * Expands to 3 slots:
 *   [{ adapter: "claude-code", model: "opus" },
 *    { adapter: "claude-code", model: "sonnet" },
 *    { adapter: "codex" }]
 */
export async function parseMatrixFile(filePath: string): Promise<MatrixFile> {
  const raw = await fs.readFile(filePath, "utf-8");
  const parsed = YAML.parse(raw);

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid matrix file: ${filePath}`);
  }

  if (!parsed.prompt || typeof parsed.prompt !== "string") {
    throw new Error("Matrix file must have a 'prompt' field (string)");
  }

  if (!Array.isArray(parsed.matrix) || parsed.matrix.length === 0) {
    throw new Error("Matrix file must have a non-empty 'matrix' array");
  }

  // Validate entries
  for (const entry of parsed.matrix) {
    if (!entry.adapter || typeof entry.adapter !== "string") {
      throw new Error(
        "Each matrix entry must have an 'adapter' field (string)",
      );
    }
  }

  return parsed as MatrixFile;
}

/**
 * Expand a MatrixFile into AdapterSlot[].
 * Handles cross-product expansion for array-valued fields.
 */
export function expandMatrix(matrix: MatrixFile): AdapterSlot[] {
  const slots: AdapterSlot[] = [];

  for (const entry of matrix.matrix) {
    const models = normalizeToArray(entry.model);

    if (models.length === 0) {
      // No model specified — single slot
      slots.push({ adapter: entry.adapter });
    } else {
      // One slot per model
      for (const model of models) {
        slots.push({ adapter: entry.adapter, model });
      }
    }
  }

  return slots;
}

/** Normalize a value to an array (handles string | string[] | undefined) */
function normalizeToArray(value: string | string[] | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}
