import { describe, expect, it } from "vitest";

import {
  LOCAL_DEFAULT_ENDPOINT,
  LOCAL_MODEL_CATALOG,
  parseLocalModels,
} from "../src/ai/localModels.js";

describe("parseLocalModels", () => {
  it("maps an OpenAI-compatible list into ModelInfo, newest-first, with no family filtering", () => {
    const models = parseLocalModels({
      object: "list",
      data: [
        { id: "llama3.1:8b", object: "model", created: 1_700_000_000 },
        { id: "qwen2.5-coder:7b", object: "model", created: 1_800_000_000 },
        // Deliberately "non-chat"-looking id: local runtimes get no filtering, so it stays.
        { id: "nomic-embed-text", object: "model", created: 1_650_000_000 },
      ],
    });

    expect(models.map((m) => m.id)).toEqual([
      "qwen2.5-coder:7b",
      "llama3.1:8b",
      "nomic-embed-text",
    ]);
    expect(models[0]).toMatchObject({ id: "qwen2.5-coder:7b", displayName: "qwen2.5-coder:7b" });
    expect(models[0]?.createdAt).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });

  it("skips entries without a string id and tolerates a missing timestamp", () => {
    const models = parseLocalModels({ data: [{ id: "mistral" }, { id: 42 }, {}, "nope"] });
    expect(models.map((m) => m.id)).toEqual(["mistral"]);
    expect(models[0]?.createdAt).toBeUndefined();
  });

  it("returns an empty list for a malformed or empty payload", () => {
    expect(parseLocalModels({})).toEqual([]);
    expect(parseLocalModels(null)).toEqual([]);
    expect(parseLocalModels({ data: "nope" })).toEqual([]);
  });

  it("ships no static catalog (models are discovered live) and defaults to Ollama's endpoint", () => {
    expect(LOCAL_MODEL_CATALOG).toEqual([]);
    expect(LOCAL_DEFAULT_ENDPOINT).toBe("http://localhost:11434/v1");
  });
});
