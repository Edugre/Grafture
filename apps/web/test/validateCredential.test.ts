import { afterEach, describe, expect, it, vi } from "vitest";

import { validateCredentialLive } from "../src/ai/validateCredential.js";

function stubFetch(impl: () => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const okModels = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ data: [], has_more: false }),
  } as Response);

const httpError = (status: number) =>
  Promise.resolve({
    ok: false,
    status,
    text: async () => JSON.stringify({ error: { message: "nope" } }),
  } as Response);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateCredentialLive", () => {
  it("accepts a credential the provider's models endpoint answers for", async () => {
    const fetchMock = stubFetch(okModels);
    const result = await validateCredentialLive("anthropic", "sk-ant-test");
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("reports a rejected key distinctly on a 401", async () => {
    stubFetch(() => httpError(401));
    const result = await validateCredentialLive("openai", "sk-revoked");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/rejected this key/i);
    }
  });

  it("reports an unreachable provider distinctly on a network failure", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const result = await validateCredentialLive("anthropic", "sk-ant-test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/couldn't reach the provider/i);
    }
  });

  it("phrases an unreachable local runtime as a server/CORS problem, not a bad credential", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const result = await validateCredentialLive("local", "http://localhost:11434/v1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/is it running|CORS/i);
    }
  });

  it("does not treat a non-auth server error as an invalid key", async () => {
    stubFetch(() => httpError(500));
    const result = await validateCredentialLive("anthropic", "sk-ant-test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toMatch(/rejected this key/i);
    }
  });
});
