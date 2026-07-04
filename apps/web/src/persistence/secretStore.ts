import type { ProviderId } from "../ai/providers.js";
import type { KeyValueStore } from "./types.js";

/**
 * Opt-in storage for the user's API keys — one per provider. These are *secrets*, kept
 * deliberately separate from project records: they are app-global, never included in project
 * import/export, and only written when the user explicitly asks us to remember them. They are
 * stored unencrypted in the browser, so they are readable by anyone with access to the device or
 * via a successful XSS — the UI warns about this and the feature defaults to off.
 *
 * The `secret:` prefix also keeps them clear of `listProjects`, which only scans `project:` keys.
 * Anthropic keeps its original `secret:anthropicApiKey` slot, so existing remembered keys survive.
 */
function keyName(provider: ProviderId): string {
  return `secret:${provider}ApiKey`;
}

export async function getStoredApiKey(
  kv: KeyValueStore,
  provider: ProviderId,
): Promise<string | undefined> {
  const value = await kv.get<string>(keyName(provider));
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function setStoredApiKey(
  kv: KeyValueStore,
  provider: ProviderId,
  key: string,
): Promise<void> {
  await kv.set(keyName(provider), key);
}

export async function clearStoredApiKey(kv: KeyValueStore, provider: ProviderId): Promise<void> {
  await kv.remove(keyName(provider));
}
