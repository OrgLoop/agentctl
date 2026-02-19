import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient } from "./daemon-client.js";

let tmpDir: string;
let sockPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-client-test-"));
  sockPath = path.join(tmpDir, "test.sock");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("DaemonClient", () => {
  describe("call", () => {
    it("sends request and receives response", async () => {
      // Create a mock server
      const server = net.createServer((conn) => {
        let buffer = "";
        conn.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            const req = JSON.parse(line);
            const resp = {
              id: req.id,
              result: { status: "ok", method: req.method },
            };
            conn.write(`${JSON.stringify(resp)}\n`);
          }
        });
      });

      await new Promise<void>((resolve) => server.listen(sockPath, resolve));

      try {
        const client = new DaemonClient(sockPath);
        const result = await client.call<{ status: string; method: string }>(
          "test.method",
          { key: "value" },
        );
        expect(result.status).toBe("ok");
        expect(result.method).toBe("test.method");
      } finally {
        server.close();
      }
    });

    it("rejects with error from server", async () => {
      const server = net.createServer((conn) => {
        let buffer = "";
        conn.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            const req = JSON.parse(line);
            const resp = {
              id: req.id,
              error: { code: "ERR", message: "Something went wrong" },
            };
            conn.write(`${JSON.stringify(resp)}\n`);
          }
        });
      });

      await new Promise<void>((resolve) => server.listen(sockPath, resolve));

      try {
        const client = new DaemonClient(sockPath);
        await expect(client.call("test.method")).rejects.toThrow(
          "Something went wrong",
        );
      } finally {
        server.close();
      }
    });

    it("rejects with connection error when daemon not running", async () => {
      const client = new DaemonClient(path.join(tmpDir, "nonexistent.sock"));
      await expect(client.call("test.method")).rejects.toThrow(
        "Daemon not running",
      );
    });
  });

  describe("isRunning", () => {
    it("returns false when daemon not running", async () => {
      const client = new DaemonClient(path.join(tmpDir, "nonexistent.sock"));
      expect(await client.isRunning()).toBe(false);
    });

    it("returns true when daemon is running", async () => {
      const server = net.createServer((conn) => {
        let buffer = "";
        conn.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            const req = JSON.parse(line);
            const resp = { id: req.id, result: { pid: 1234 } };
            conn.write(`${JSON.stringify(resp)}\n`);
          }
        });
      });

      await new Promise<void>((resolve) => server.listen(sockPath, resolve));

      try {
        const client = new DaemonClient(sockPath);
        expect(await client.isRunning()).toBe(true);
      } finally {
        server.close();
      }
    });
  });
});
