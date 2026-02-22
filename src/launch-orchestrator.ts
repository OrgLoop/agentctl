import crypto from "node:crypto";
import path from "node:path";
import type { AgentAdapter, LaunchOpts, LifecycleHooks } from "./core/types.js";
import { runHook } from "./hooks.js";
import { createWorktree, type WorktreeInfo } from "./worktree.js";

// --- Types ---

/** A single adapter+model slot parsed from CLI flags */
export interface AdapterSlot {
  adapter: string;
  model?: string;
}

/** Result of launching one slot within a group */
export interface SlotLaunchResult {
  slot: AdapterSlot;
  sessionId: string;
  pid?: number;
  cwd: string;
  branch: string;
  error?: string;
}

/** Result of the full orchestrated launch */
export interface OrchestratedLaunchResult {
  groupId: string;
  results: SlotLaunchResult[];
}

export interface OrchestrateOpts {
  slots: AdapterSlot[];
  prompt: string;
  spec?: string;
  cwd: string;
  hooks?: LifecycleHooks;
  adapters: Record<string, AgentAdapter>;
  /** Optional: callback when daemon is available for lock/track */
  onSessionLaunched?: (result: SlotLaunchResult) => void;
}

// --- Group ID generation ---

/** Generate a short group ID like "g-a1b2c3" */
export function generateGroupId(): string {
  const hex = crypto.randomBytes(3).toString("hex");
  return `g-${hex}`;
}

// --- Slot disambiguation ---

/**
 * Generate a short suffix for a slot, used in worktree/branch naming.
 * When an adapter appears multiple times, disambiguate using the model short name.
 */
export function slotSuffix(slot: AdapterSlot, allSlots: AdapterSlot[]): string {
  const sameAdapter = allSlots.filter((s) => s.adapter === slot.adapter);

  // Short adapter name: claude-code → cc, codex → codex, etc.
  const adapterShort = shortenAdapter(slot.adapter);

  if (sameAdapter.length <= 1) {
    return adapterShort;
  }

  // Disambiguate with model short name
  const modelShort = slot.model ? shortenModel(slot.model) : "default";
  return `${adapterShort}-${modelShort}`;
}

/** Shorten adapter names for path-friendly suffixes */
function shortenAdapter(adapter: string): string {
  const map: Record<string, string> = {
    "claude-code": "cc",
    "pi-rust": "pi-rs",
  };
  return map[adapter] || adapter;
}

/** Extract a short model name from a full model identifier */
function shortenModel(model: string): string {
  // claude-opus-4-6 → opus, claude-sonnet-4-5 → sonnet
  const opusMatch = model.match(/opus/i);
  if (opusMatch) return "opus";
  const sonnetMatch = model.match(/sonnet/i);
  if (sonnetMatch) return "sonnet";
  const haikuMatch = model.match(/haiku/i);
  if (haikuMatch) return "haiku";

  // gpt-5.2-codex → gpt5-codex
  const gptMatch = model.match(/gpt[- ]?(\d+)/i);
  if (gptMatch) {
    const rest = model.replace(/gpt[- ]?\d+\.?\d*/i, "").replace(/^[- .]+/, "");
    return rest ? `gpt${gptMatch[1]}-${rest}` : `gpt${gptMatch[1]}`;
  }

  // Fallback: take last segment, sanitize
  const parts = model.split(/[/:-]/);
  return sanitizePath(parts[parts.length - 1] || model);
}

/** Sanitize a string for use in file paths and branch names */
function sanitizePath(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase() || "default";
}

// --- Worktree + branch naming ---

/** Build worktree path: <repo>-<groupId>-<suffix> */
export function worktreePath(repo: string, groupId: string, suffix: string): string {
  const repoResolved = path.resolve(repo);
  return `${repoResolved}-${groupId}-${suffix}`;
}

/** Build branch name: try/<groupId>/<suffix> */
export function branchName(groupId: string, suffix: string): string {
  return `try/${groupId}/${suffix}`;
}

// --- Orchestrator ---

/**
 * Orchestrate a parallel multi-adapter launch.
 *
 * 1. Generate group ID
 * 2. For each slot: create worktree, run on_worktree_create hook, launch adapter
 * 3. Return all results (successes and failures)
 */
export async function orchestrateLaunch(
  opts: OrchestrateOpts,
): Promise<OrchestratedLaunchResult> {
  const { slots, prompt, spec, cwd, hooks, adapters } = opts;
  const groupId = generateGroupId();
  const repo = path.resolve(cwd);

  // Phase 1: Create all worktrees (sequential to avoid git lock contention)
  const worktrees: Array<{
    slot: AdapterSlot;
    suffix: string;
    branch: string;
    worktree: WorktreeInfo;
  }> = [];

  for (const slot of slots) {
    const suffix = slotSuffix(slot, slots);
    const branch = branchName(groupId, suffix);
    const wtPath = worktreePath(repo, groupId, suffix);

    const worktree = await createWorktree({
      repo,
      branch,
    });

    // The createWorktree function names the path based on repo+branch slug.
    // We need to override for our naming convention.
    // Actually — createWorktree uses `<repo>-<branch-slug>` which for
    // branch "try/g-a1b2c3/cc" becomes "<repo>-try-g-a1b2c3-cc".
    // That's acceptable. Let's use the path it returns.

    worktrees.push({ slot, suffix, branch, worktree });

    // Run on_worktree_create hook (onCreate) if provided
    if (hooks?.onCreate) {
      await runHook(hooks, "onCreate", {
        sessionId: "", // not yet launched
        cwd: worktree.path,
        adapter: slot.adapter,
        branch,
      });
    }
  }

  // Phase 2: Launch all adapters in parallel
  const launchPromises = worktrees.map(async ({ slot, suffix, branch, worktree }) => {
    const adapter = adapters[slot.adapter];
    if (!adapter) {
      return {
        slot,
        sessionId: "",
        cwd: worktree.path,
        branch,
        error: `Unknown adapter: ${slot.adapter}`,
      } satisfies SlotLaunchResult;
    }

    try {
      const launchOpts: LaunchOpts = {
        adapter: slot.adapter,
        prompt,
        spec,
        cwd: worktree.path,
        model: slot.model,
        worktree: { repo: worktree.repo, branch },
        hooks,
      };

      const session = await adapter.launch(launchOpts);

      // Tag the session with the group
      session.group = groupId;

      const result: SlotLaunchResult = {
        slot,
        sessionId: session.id,
        pid: session.pid,
        cwd: worktree.path,
        branch,
      };

      opts.onSessionLaunched?.(result);
      return result;
    } catch (err) {
      return {
        slot,
        sessionId: "",
        cwd: worktree.path,
        branch,
        error: (err as Error).message,
      } satisfies SlotLaunchResult;
    }
  });

  const results = await Promise.all(launchPromises);
  return { groupId, results };
}

// --- CLI flag parsing ---

/**
 * Parse positional adapter slots from raw argv.
 *
 * Multiple --adapter flags, each optionally followed by --model:
 *   --adapter claude-code --model opus --adapter codex
 *
 * Returns AdapterSlot[] representing each launch slot.
 */
export function parseAdapterSlots(rawArgs: string[]): AdapterSlot[] {
  const slots: AdapterSlot[] = [];
  let current: AdapterSlot | null = null;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--adapter" || arg === "-A") {
      // Flush previous slot
      if (current) slots.push(current);
      const value = rawArgs[++i];
      if (!value || value.startsWith("-")) {
        throw new Error(`--adapter requires a value`);
      }
      current = { adapter: value };
    } else if (arg === "--model" || arg === "-M") {
      if (!current) {
        throw new Error(`--model must follow an --adapter flag`);
      }
      const value = rawArgs[++i];
      if (!value || value.startsWith("-")) {
        throw new Error(`--model requires a value`);
      }
      current.model = value;
    }
  }

  // Flush last slot
  if (current) slots.push(current);

  return slots;
}
