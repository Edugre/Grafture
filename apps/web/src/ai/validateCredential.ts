import { DEFAULT_TARGET } from "@schema-studio/core";

import { PROVIDERS, type ProviderId } from "./providers.js";

export type CredentialCheck =
  | { ok: true }
  | {
      ok: false;
      /**
       * Why the check failed: `rejected` means the provider answered and refused the
       * credential; `unreachable` means it never answered (offline, outage, rate limit) —
       * callers may let the user save an unverified credential in that case, since a
       * transient outage says nothing about the key itself.
       */
      reason: "rejected" | "unreachable";
      error: string;
    };

/** Providers embed the HTTP status in thrown messages as "(401)" — see listModels impls. */
const AUTH_STATUS = /\((401|403)\)/;

/**
 * Live-check a credential by making the cheapest authenticated call the provider supports —
 * its models listing. This is what turns the BYO-key form's format check into a real
 * validation: a well-formed but revoked key fails here, before it's saved as the active
 * provider. Distinguishes a rejected credential from an unreachable server so the UI can
 * phrase the failure honestly (a stopped local runtime is not an invalid endpoint).
 */
export async function validateCredentialLive(
  id: ProviderId,
  credential: string,
): Promise<CredentialCheck> {
  const meta = PROVIDERS[id];
  const provider = meta.create(credential, meta.defaultModel ?? "", DEFAULT_TARGET);
  if (!provider.listModels) {
    // No pingable surface — accept the format-valid credential rather than block saving.
    return { ok: true };
  }

  try {
    await provider.listModels();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (AUTH_STATUS.test(message)) {
      return {
        ok: false,
        reason: "rejected",
        error:
          id === "local"
            ? "The server rejected the request — check its auth settings."
            : "The provider rejected this key — check that it's active and has API access.",
      };
    }
    return {
      ok: false,
      reason: "unreachable",
      error:
        id === "local"
          ? "Couldn't reach the server — is it running and allowing this origin (CORS)?"
          : "Couldn't reach the provider to verify the key — check your connection and try again.",
    };
  }
}
