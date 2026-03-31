import fs from "node:fs/promises";
import os from "node:os";
import YAML from "yaml";
import type { AdapterSlot } from "./launch-orchestrator.js";

// --- Types ---

/** A single entry in the matrix array */
export interface MatrixEntry {
  adapter: string;
  model?: string | string[];
  /** Branch name for this entry's worktree */
  branch?: string;
  /** Base branch to create worktree from (default: main). Accepts both snake_case and camelCase. */
  base_branch?: string;
  baseBranch?: string;
}

/** Top-level matrix file schema */
export interface MatrixFile {
  prompt?: string;
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

  if (parsed.prompt !== undefined && typeof parsed.prompt !== "string") {
    throw new Error("Matrix file 'prompt' field must be a string");
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
    // Carry over optional per-entry fields
    const extra: Partial<AdapterSlot> = {};
    if (entry.branch) extra.branch = entry.branch;
    const baseBranch = entry.base_branch || entry.baseBranch;
    if (baseBranch) extra.baseBranch = baseBranch;

    if (models.length === 0) {
      // No model specified — single slot
      slots.push({ adapter: entry.adapter, ...extra });
    } else {
      // One slot per model
      for (const model of models) {
        slots.push({ adapter: entry.adapter, model, ...extra });
      }
    }
  }

  return slots;
}

/** Expand leading ~ to the user's home directory */
export function expandTildePath(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return os.homedir() + p.slice(1);
  }
  return p;
}

/** Normalize a value to an array (handles string | string[] | undefined) */
function normalizeToArray(value: string | string[] | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}
