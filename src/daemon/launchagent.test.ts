import os from "node:os";
import { describe, expect, it } from "vitest";
import { generatePlist } from "./launchagent.js";

describe("generatePlist", () => {
  it("generates valid plist XML", () => {
    const plist = generatePlist({
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/agentctl/dist/cli.js",
    });

    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain('<plist version="1.0">');
    expect(plist).toContain("com.agentctl.daemon");
    expect(plist).toContain("/usr/local/bin/node");
    expect(plist).toContain("cli.js");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("daemon.stdout.log");
    expect(plist).toContain("daemon.stderr.log");
  });

  it("includes HOME environment variable", () => {
    const plist = generatePlist({
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/agentctl/dist/cli.js",
    });
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain(os.homedir());
  });

  it("includes node binary dir in PATH", () => {
    const plist = generatePlist({
      nodePath: "/opt/node/bin/node",
      cliPath: "/opt/agentctl/dist/cli.js",
    });
    expect(plist).toContain("/opt/node/bin");
  });

  it("includes --foreground flag", () => {
    const plist = generatePlist({
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/agentctl/dist/cli.js",
    });
    expect(plist).toContain("--foreground");
  });
});
