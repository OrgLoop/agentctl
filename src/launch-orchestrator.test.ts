import { describe, expect, it } from "vitest";
import {
  type AdapterSlot,
  branchName,
  generateGroupId,
  parseAdapterSlots,
  slotSuffix,
} from "./launch-orchestrator.js";

describe("generateGroupId", () => {
  it("generates a g-prefixed hex string", () => {
    const id = generateGroupId();
    expect(id).toMatch(/^g-[a-f0-9]{6}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateGroupId()));
    // With 3 bytes of randomness, 100 IDs should all be unique
    expect(ids.size).toBe(100);
  });
});

describe("slotSuffix", () => {
  it("uses short adapter name for unique adapters", () => {
    const slots: AdapterSlot[] = [
      { adapter: "claude-code" },
      { adapter: "codex" },
    ];
    expect(slotSuffix(slots[0], slots)).toBe("cc");
    expect(slotSuffix(slots[1], slots)).toBe("codex");
  });

  it("disambiguates same adapter with different models", () => {
    const slots: AdapterSlot[] = [
      { adapter: "claude-code", model: "claude-opus-4-6" },
      { adapter: "claude-code", model: "claude-sonnet-4-5" },
      { adapter: "codex" },
    ];
    expect(slotSuffix(slots[0], slots)).toBe("cc-opus");
    expect(slotSuffix(slots[1], slots)).toBe("cc-sonnet");
    expect(slotSuffix(slots[2], slots)).toBe("codex");
  });

  it("uses 'default' when same adapter appears twice without models", () => {
    const slots: AdapterSlot[] = [
      { adapter: "claude-code" },
      { adapter: "claude-code" },
    ];
    expect(slotSuffix(slots[0], slots)).toBe("cc-default");
  });

  it("handles pi-rust adapter shortening", () => {
    const slots: AdapterSlot[] = [{ adapter: "pi-rust" }];
    expect(slotSuffix(slots[0], slots)).toBe("pi-rs");
  });

  it("handles GPT model names", () => {
    const slots: AdapterSlot[] = [
      { adapter: "codex", model: "gpt-5.2-codex" },
      { adapter: "codex", model: "gpt-4o" },
    ];
    expect(slotSuffix(slots[0], slots)).toBe("codex-gpt5-codex");
    expect(slotSuffix(slots[1], slots)).toBe("codex-gpt4-o");
  });
});

describe("branchName", () => {
  it("generates try/<groupId>/<suffix> format", () => {
    expect(branchName("g-abc123", "cc")).toBe("try/g-abc123/cc");
    expect(branchName("g-abc123", "cc-opus")).toBe("try/g-abc123/cc-opus");
  });
});

describe("parseAdapterSlots", () => {
  it("parses single --adapter", () => {
    const slots = parseAdapterSlots(["--adapter", "claude-code"]);
    expect(slots).toEqual([{ adapter: "claude-code" }]);
  });

  it("parses multiple --adapter flags", () => {
    const slots = parseAdapterSlots([
      "--adapter",
      "claude-code",
      "--adapter",
      "codex",
      "--adapter",
      "pi",
    ]);
    expect(slots).toEqual([
      { adapter: "claude-code" },
      { adapter: "codex" },
      { adapter: "pi" },
    ]);
  });

  it("parses --adapter with --model", () => {
    const slots = parseAdapterSlots([
      "--adapter",
      "claude-code",
      "--model",
      "claude-opus-4-6",
      "--adapter",
      "claude-code",
      "--model",
      "claude-sonnet-4-5",
    ]);
    expect(slots).toEqual([
      { adapter: "claude-code", model: "claude-opus-4-6" },
      { adapter: "claude-code", model: "claude-sonnet-4-5" },
    ]);
  });

  it("handles mixed with and without models", () => {
    const slots = parseAdapterSlots([
      "--adapter",
      "claude-code",
      "--model",
      "opus",
      "--adapter",
      "codex",
      "-p",
      "some prompt",
    ]);
    expect(slots).toEqual([
      { adapter: "claude-code", model: "opus" },
      { adapter: "codex" },
    ]);
  });

  it("ignores non-adapter/model flags", () => {
    const slots = parseAdapterSlots([
      "launch",
      "--adapter",
      "claude-code",
      "-p",
      "do stuff",
      "--cwd",
      "/tmp",
      "--adapter",
      "codex",
    ]);
    expect(slots).toEqual([{ adapter: "claude-code" }, { adapter: "codex" }]);
  });

  it("throws when --model appears before --adapter", () => {
    expect(() =>
      parseAdapterSlots(["--model", "opus", "--adapter", "claude-code"]),
    ).toThrow("--model must follow an --adapter flag");
  });

  it("throws when --adapter has no value", () => {
    expect(() => parseAdapterSlots(["--adapter"])).toThrow(
      "--adapter requires a value",
    );
  });

  it("returns empty array when no --adapter flags", () => {
    const slots = parseAdapterSlots(["launch", "-p", "hello"]);
    expect(slots).toEqual([]);
  });

  it("supports -A and -M shorthand", () => {
    const slots = parseAdapterSlots([
      "-A",
      "claude-code",
      "-M",
      "opus",
      "-A",
      "codex",
    ]);
    expect(slots).toEqual([
      { adapter: "claude-code", model: "opus" },
      { adapter: "codex" },
    ]);
  });
});
