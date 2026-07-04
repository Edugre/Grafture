import { describe, expect, it } from "vitest";

import { MemoryKeyValueStore } from "../src/persistence/kv.js";
import {
  clearStoredApiKey,
  getStoredApiKey,
  setStoredApiKey,
} from "../src/persistence/secretStore.js";

describe("secretStore", () => {
  it("stores, reads, and clears the API key", async () => {
    const kv = new MemoryKeyValueStore();
    expect(await getStoredApiKey(kv, "anthropic")).toBeUndefined();

    await setStoredApiKey(kv, "anthropic", "sk-ant-123");
    expect(await getStoredApiKey(kv, "anthropic")).toBe("sk-ant-123");

    await clearStoredApiKey(kv, "anthropic");
    expect(await getStoredApiKey(kv, "anthropic")).toBeUndefined();
  });

  it("treats an empty stored value as absent", async () => {
    const kv = new MemoryKeyValueStore();
    await setStoredApiKey(kv, "anthropic", "");
    expect(await getStoredApiKey(kv, "anthropic")).toBeUndefined();
  });

  it("keeps each provider's key in its own slot", async () => {
    const kv = new MemoryKeyValueStore();
    await setStoredApiKey(kv, "anthropic", "sk-ant-123");
    await setStoredApiKey(kv, "openai", "sk-openai-456");

    expect(await getStoredApiKey(kv, "anthropic")).toBe("sk-ant-123");
    expect(await getStoredApiKey(kv, "openai")).toBe("sk-openai-456");

    // Clearing one leaves the other intact.
    await clearStoredApiKey(kv, "anthropic");
    expect(await getStoredApiKey(kv, "anthropic")).toBeUndefined();
    expect(await getStoredApiKey(kv, "openai")).toBe("sk-openai-456");
  });

  it("preserves the original Anthropic storage slot for existing keys", async () => {
    const kv = new MemoryKeyValueStore();
    await setStoredApiKey(kv, "anthropic", "sk-ant-123");
    const keys = await kv.keys();
    expect(keys).toContain("secret:anthropicApiKey");
  });

  it("keeps the secret out of the project key namespace", async () => {
    const kv = new MemoryKeyValueStore();
    await setStoredApiKey(kv, "anthropic", "sk-ant-123");
    const keys = await kv.keys();
    expect(keys.some((key) => key.startsWith("project:"))).toBe(false);
  });
});
