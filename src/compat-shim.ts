#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

console.error(
  "\u26a0\ufe0f  agent-ctl is renamed to agentctl. Please update your scripts.",
);

const __filename = fileURLToPath(import.meta.url);
const agentctlBin = path.join(path.dirname(__filename), "cli.js");

try {
  execFileSync(process.execPath, [agentctlBin, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
} catch (err) {
  process.exit((err as { status?: number }).status ?? 1);
}
