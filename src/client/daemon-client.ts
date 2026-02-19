import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DEFAULT_SOCK_PATH = path.join(os.homedir(), ".agentctl", "agentctl.sock");

export class DaemonClient {
  private sockPath: string;

  constructor(sockPath?: string) {
    this.sockPath = sockPath || DEFAULT_SOCK_PATH;
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.sockPath);
      const id = crypto.randomUUID();
      let buffer = "";
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error("Daemon request timed out"));
        }
      }, 30_000);

      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });

      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === id && !msg.stream) {
              settled = true;
              clearTimeout(timeout);
              if (msg.error) reject(new Error(msg.error.message));
              else resolve(msg.result as T);
              socket.end();
            }
          } catch {
            // Malformed response
          }
        }
      });

      socket.on("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
          reject(
            new Error("Daemon not running. Start with: agentctl daemon start"),
          );
        } else {
          reject(err);
        }
      });

      socket.on("close", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("Connection closed before response received"));
        }
      });
    });
  }

  async isRunning(): Promise<boolean> {
    try {
      await this.call("daemon.status");
      return true;
    } catch {
      return false;
    }
  }
}
