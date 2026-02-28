import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Persistent config defaults loaded from ~/.agentctl/config.json */
export interface AgentCtlConfig {
  adapter?: string;
  model?: string;
  cwd?: string;
  timeout?: number;
}

export const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  ".agentctl",
  "config.json",
);

/**
 * Load config defaults from ~/.agentctl/config.json (or a custom path).
 * Returns an empty object if the file doesn't exist or is malformed.
 */
export async function loadConfig(
  configPath = DEFAULT_CONFIG_PATH,
): Promise<AgentCtlConfig> {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as AgentCtlConfig;
  } catch {
    return {};
  }
}
