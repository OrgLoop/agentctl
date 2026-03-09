import { describe, expect, it } from "vitest";
import { AcpAdapter } from "./acp/acp-adapter.js";
import { codexAcpAgentConfig, createCodexAcpAdapter } from "./codex-acp.js";

describe("codex-acp", () => {
  describe("codexAcpAgentConfig", () => {
    it("uses codex-acp command", () => {
      expect(codexAcpAgentConfig.command).toBe("codex-acp");
      expect(codexAcpAgentConfig.name).toBe("Codex (ACP)");
    });
  });

  describe("createCodexAcpAdapter", () => {
    it("creates an AcpAdapter with id codex-acp", () => {
      const adapter = createCodexAcpAdapter();
      expect(adapter).toBeInstanceOf(AcpAdapter);
      expect(adapter.id).toBe("codex-acp");
    });

    it("allows overriding config", () => {
      const adapter = createCodexAcpAdapter({
        permissionPolicy: "deny",
      });
      expect(adapter).toBeInstanceOf(AcpAdapter);
      expect(adapter.id).toBe("codex-acp");
    });
  });
});
