import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generate a LaunchAgent plist with dynamically resolved paths.
 */
export function generatePlist(opts?: {
  nodePath?: string;
  cliPath?: string;
}): string {
  const home = os.homedir();
  const nodePath = opts?.nodePath || process.execPath;
  const cliPath =
    opts?.cliPath ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  // Normalize to absolute
  const resolvedCliPath = path.resolve(cliPath);

  // Get PATH including node's bin dir
  const nodeBinDir = path.dirname(nodePath);
  const envPath = `/usr/local/bin:/usr/bin:/bin:${nodeBinDir}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agentctl.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${resolvedCliPath}</string>
        <string>daemon</string>
        <string>start</string>
        <string>--foreground</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${home}/.agentctl/daemon.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${home}/.agentctl/daemon.stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${envPath}</string>
        <key>HOME</key>
        <string>${home}</string>
    </dict>
</dict>
</plist>
`;
}
