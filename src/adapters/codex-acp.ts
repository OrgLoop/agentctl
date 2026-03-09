/**
 * Codex ACP Adapter — runs Codex via ACP instead of PTY scraping.
 *
 * Uses @zed-industries/codex-acp as the ACP bridge for Codex CLI.
 * This is a thin wrapper over the generic AcpAdapter with Codex-specific config.
 *
 * Falls back to the existing CodexAdapter (PTY) when the ACP bridge is unavailable.
 */
import { AcpAdapter, type AcpAdapterOpts } from "./acp/acp-adapter.js";
import type { AcpAgentConfig } from "./acp/acp-client.js";

/** The ACP bridge command for Codex */
const CODEX_ACP_COMMAND = "codex-acp";

/** Default args — runs headless with full approvals */
const CODEX_ACP_ARGS: string[] = [];

/** Default agent config for Codex via ACP */
export const codexAcpAgentConfig: AcpAgentConfig = {
  command: CODEX_ACP_COMMAND,
  args: CODEX_ACP_ARGS,
  name: "Codex (ACP)",
};

/**
 * Create a Codex adapter that uses ACP transport.
 *
 * @param overrides — Optional config overrides (e.g. custom command path)
 */
export function createCodexAcpAdapter(
  overrides?: Partial<AcpAdapterOpts>,
): AcpAdapter {
  return new AcpAdapter("codex-acp", {
    agentConfig: codexAcpAgentConfig,
    permissionPolicy: "auto-approve",
    ...overrides,
  });
}
