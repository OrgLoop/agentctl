import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSupervisorPid } from "./supervisor.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-sup-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("getSupervisorPid", () => {
  it("returns null when no PID file exists", async () => {
    const pid = await getSupervisorPid(tmpDir);
    expect(pid).toBeNull();
  });

  it("returns null when PID file has dead PID", async () => {
    // Use a PID that definitely doesn't exist
    await fs.writeFile(path.join(tmpDir, "supervisor.pid"), "999999999");
    const pid = await getSupervisorPid(tmpDir);
    expect(pid).toBeNull();
  });

  it("returns PID when process is alive (current process)", async () => {
    // Use current process PID — guaranteed alive
    await fs.writeFile(
      path.join(tmpDir, "supervisor.pid"),
      String(process.pid),
    );
    const pid = await getSupervisorPid(tmpDir);
    expect(pid).toBe(process.pid);
  });
});
