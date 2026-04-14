import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const {
  getProviderFromModel,
  getApiKeyEnvVar,
  validateApiKeyForModel,
  readWorkspaceModel,
  resolveOpenCodeModel,
  MODEL_FALLBACKS,
  PROVIDER_API_KEY_MAP,
} = await import("./opencode.js");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-opencode-model-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("getProviderFromModel", () => {
  it("extracts provider from provider-prefixed models", () => {
    expect(getProviderFromModel("openai/gpt-5.4")).toBe("openai");
    expect(getProviderFromModel("anthropic/claude-opus-4-6")).toBe("anthropic");
    expect(getProviderFromModel("google/gemini-pro")).toBe("google");
  });

  it("returns undefined for bare model names", () => {
    expect(getProviderFromModel("gpt-4o")).toBeUndefined();
    expect(getProviderFromModel("deepseek-r1")).toBeUndefined();
    expect(getProviderFromModel("claude-sonnet-4-6")).toBeUndefined();
  });
});

describe("getApiKeyEnvVar", () => {
  it("maps known providers to their API key env vars", () => {
    expect(getApiKeyEnvVar("openai")).toBe("OPENAI_API_KEY");
    expect(getApiKeyEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(getApiKeyEnvVar("google")).toBe("GOOGLE_API_KEY");
    expect(getApiKeyEnvVar("mistral")).toBe("MISTRAL_API_KEY");
  });

  it("falls back to <PROVIDER>_API_KEY for unknown providers", () => {
    expect(getApiKeyEnvVar("customai")).toBe("CUSTOMAI_API_KEY");
    expect(getApiKeyEnvVar("MyProvider")).toBe("MYPROVIDER_API_KEY");
  });
});

describe("PROVIDER_API_KEY_MAP", () => {
  it("contains expected providers", () => {
    expect(PROVIDER_API_KEY_MAP).toMatchObject({
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      google: "GOOGLE_API_KEY",
    });
  });
});

describe("validateApiKeyForModel", () => {
  it("throws if provider-prefixed model has no API key in env", () => {
    expect(() => validateApiKeyForModel("openai/gpt-5.4", {})).toThrow(
      "Model 'openai/gpt-5.4' requires OPENAI_API_KEY which is not set. Pass --model to override.",
    );
  });

  it("does not throw if provider-prefixed model has API key in env", () => {
    expect(() =>
      validateApiKeyForModel("openai/gpt-5.4", { OPENAI_API_KEY: "sk-test" }),
    ).not.toThrow();
  });

  it("does not throw for bare model names (provider unknown)", () => {
    expect(() => validateApiKeyForModel("gpt-4o", {})).not.toThrow();
    expect(() => validateApiKeyForModel("claude-sonnet-4-6", {})).not.toThrow();
  });

  it("uses process.env by default", () => {
    // This just verifies it doesn't crash when called without env arg
    // (actual behavior depends on process.env in test runner)
    expect(() => validateApiKeyForModel("bare-model-name")).not.toThrow();
  });

  it("produces clear error message for anthropic models", () => {
    expect(() =>
      validateApiKeyForModel("anthropic/claude-opus-4-6", {}),
    ).toThrow(
      "Model 'anthropic/claude-opus-4-6' requires ANTHROPIC_API_KEY which is not set. Pass --model to override.",
    );
  });
});

describe("readWorkspaceModel", () => {
  it("reads model string from opencode.json in cwd", async () => {
    await fs.writeFile(
      path.join(tmpDir, "opencode.json"),
      JSON.stringify({ model: "claude-opus-4-5" }),
    );
    expect(await readWorkspaceModel(tmpDir)).toBe("claude-opus-4-5");
  });

  it("returns undefined when opencode.json has no model field", async () => {
    await fs.writeFile(
      path.join(tmpDir, "opencode.json"),
      JSON.stringify({ otherSetting: true }),
    );
    expect(await readWorkspaceModel(tmpDir)).toBeUndefined();
  });

  it("returns undefined when no config files exist", async () => {
    expect(await readWorkspaceModel(tmpDir)).toBeUndefined();
  });

  it("returns undefined when opencode.json is malformed JSON", async () => {
    await fs.writeFile(path.join(tmpDir, "opencode.json"), "not-json{");
    expect(await readWorkspaceModel(tmpDir)).toBeUndefined();
  });

  it("ignores empty string model values", async () => {
    await fs.writeFile(
      path.join(tmpDir, "opencode.json"),
      JSON.stringify({ model: "" }),
    );
    expect(await readWorkspaceModel(tmpDir)).toBeUndefined();
  });
});

describe("MODEL_FALLBACKS", () => {
  it("has anthropic before openai", () => {
    const anthropicIdx = MODEL_FALLBACKS.findIndex(
      (f) => f.keyVar === "ANTHROPIC_API_KEY",
    );
    const openaiIdx = MODEL_FALLBACKS.findIndex(
      (f) => f.keyVar === "OPENAI_API_KEY",
    );
    expect(anthropicIdx).toBeGreaterThanOrEqual(0);
    expect(openaiIdx).toBeGreaterThan(anthropicIdx);
  });
});

describe("resolveOpenCodeModel", () => {
  it("returns bare opts.model directly (highest priority)", async () => {
    const result = await resolveOpenCodeModel(
      { model: "deepseek-r1", cwd: tmpDir },
      {},
    );
    expect(result).toBe("deepseek-r1");
  });

  it("strips provider prefix from opts.model when API key is present", async () => {
    const result = await resolveOpenCodeModel(
      { model: "openai/gpt-5.4", cwd: tmpDir },
      { OPENAI_API_KEY: "sk-test" },
    );
    expect(result).toBe("gpt-5.4");
  });

  it("throws when provider-prefixed opts.model has missing API key", async () => {
    await expect(
      resolveOpenCodeModel({ model: "openai/gpt-5.4", cwd: tmpDir }, {}),
    ).rejects.toThrow(
      "Model 'openai/gpt-5.4' requires OPENAI_API_KEY which is not set.",
    );
  });

  it("falls back to workspace config when no opts.model", async () => {
    await fs.writeFile(
      path.join(tmpDir, "opencode.json"),
      JSON.stringify({ model: "gpt-4o" }),
    );
    const result = await resolveOpenCodeModel({ cwd: tmpDir }, {});
    expect(result).toBe("gpt-4o");
  });

  it("workspace config takes priority over OPENCODE_MODEL env var", async () => {
    await fs.writeFile(
      path.join(tmpDir, "opencode.json"),
      JSON.stringify({ model: "workspace-model" }),
    );
    const result = await resolveOpenCodeModel(
      { cwd: tmpDir },
      { OPENCODE_MODEL: "env-model" },
    );
    expect(result).toBe("workspace-model");
  });

  it("falls back to OPENCODE_MODEL env var when no opts.model or workspace config", async () => {
    const result = await resolveOpenCodeModel(
      { cwd: tmpDir },
      { OPENCODE_MODEL: "gemma-3" },
    );
    expect(result).toBe("gemma-3");
  });

  it("falls back to anthropic model when ANTHROPIC_API_KEY is set", async () => {
    const result = await resolveOpenCodeModel(
      { cwd: tmpDir },
      { ANTHROPIC_API_KEY: "sk-ant-test" },
    );
    expect(result).toBe("claude-sonnet-4-6");
  });

  it("falls back to openai model when only OPENAI_API_KEY is set", async () => {
    const result = await resolveOpenCodeModel(
      { cwd: tmpDir },
      { OPENAI_API_KEY: "sk-test" },
    );
    expect(result).toBe("gpt-4o");
  });

  it("prefers anthropic over openai in fallback order", async () => {
    const result = await resolveOpenCodeModel(
      { cwd: tmpDir },
      { ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" },
    );
    expect(result).toBe("claude-sonnet-4-6");
  });

  it("returns undefined when no model can be resolved", async () => {
    const result = await resolveOpenCodeModel({ cwd: tmpDir }, {});
    expect(result).toBeUndefined();
  });

  it("opts.model takes priority over workspace config", async () => {
    await fs.writeFile(
      path.join(tmpDir, "opencode.json"),
      JSON.stringify({ model: "workspace-model" }),
    );
    const result = await resolveOpenCodeModel(
      { model: "explicit-model", cwd: tmpDir },
      {},
    );
    expect(result).toBe("explicit-model");
  });
});
