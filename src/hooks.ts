import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { LifecycleHooks } from "./core/types.js";

const execAsync = promisify(exec);

export type HookPhase = "onCreate" | "onComplete" | "preMerge" | "postMerge";

export interface HookContext {
  sessionId: string;
  cwd: string;
  adapter: string;
  branch?: string;
  exitCode?: number;
  group?: string;
  model?: string;
}

/**
 * Run a lifecycle hook script if defined.
 * Hook scripts receive context via environment variables:
 *   AGENTCTL_SESSION_ID, AGENTCTL_CWD, AGENTCTL_ADAPTER,
 *   AGENTCTL_BRANCH, AGENTCTL_EXIT_CODE
 */
export async function runHook(
  hooks: LifecycleHooks | undefined,
  phase: HookPhase,
  ctx: HookContext,
): Promise<{ stdout: string; stderr: string } | null> {
  if (!hooks) return null;
  const script = hooks[phase];
  if (!script) return null;

  const env: Record<string, string> = {
    ...process.env,
    AGENTCTL_SESSION_ID: ctx.sessionId,
    AGENTCTL_CWD: ctx.cwd,
    AGENTCTL_ADAPTER: ctx.adapter,
  } as Record<string, string>;

  if (ctx.branch) env.AGENTCTL_BRANCH = ctx.branch;
  if (ctx.exitCode != null) env.AGENTCTL_EXIT_CODE = String(ctx.exitCode);
  if (ctx.group) env.AGENTCTL_GROUP = ctx.group;
  if (ctx.model) env.AGENTCTL_MODEL = ctx.model;

  try {
    const result = await execAsync(script, {
      cwd: ctx.cwd,
      env,
      timeout: 60_000,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    console.error(`Hook ${phase} failed:`, e.message);
    return { stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}
