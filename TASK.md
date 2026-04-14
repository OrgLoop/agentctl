# Fix: opencode adapter defaults to wrong model

**Issue:** https://github.com/c-h-personal/agentctl/issues/16
**Closes:** #16

## Problem

`agentctl launch opencode` ignores the workspace/default opencode model configuration and selects `openai/gpt-5.4` as the model. If `OPENAI_API_KEY` is not set, the session fails silently — exits with no error message, no output.

This affects every opencode launch that doesn't pass an explicit `--model` flag.

Related reports: #155, #148, #159 (all same root cause).

## What to Fix

Fix the model resolution order in the opencode adapter to:

1. **Explicit `--model` flag** (highest priority — already works)
2. **Workspace config** (opencode's own config file if present)
3. **Environment-based default** (e.g., from `OPENCODE_MODEL` env var)
4. **Sensible fallback** (a model that's likely to work — e.g., `anthropic/claude-sonnet-4-6` if Anthropic key is set, or fail loudly)

Additionally:
- **Fail loudly** if the selected model's provider API key is missing. No silent exits.
- Print a clear error: `"Error: Model 'openai/gpt-5.4' requires OPENAI_API_KEY which is not set. Pass --model to override."`

## Approach

1. Find the opencode adapter (likely `src/adapters/opencode/` or similar)
2. Find where the model is resolved/selected
3. Fix the resolution order
4. Add API key validation — check that the provider's key exists before launching
5. Write unit tests for model resolution with different configs

## Requirements

- Model resolution: `--model` > workspace config > env var > sensible fallback
- Fail loudly with actionable error if provider key is missing
- Write tests for resolution order + missing key scenarios
- Run typecheck and lint before finishing

COMMIT AND PUSH before finishing.
