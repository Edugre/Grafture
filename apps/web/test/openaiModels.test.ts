import { describe, expect, it } from "vitest";

import { mergeModels } from "../src/ai/models.js";
import {
  OPENAI_MODEL_CATALOG,
  isSelectableOpenAiModel,
  parseOpenAiModels,
} from "../src/ai/openaiModels.js";

describe("isSelectableOpenAiModel", () => {
  it("accepts chat and reasoning families", () => {
    expect(isSelectableOpenAiModel("gpt-4.1")).toBe(true);
    expect(isSelectableOpenAiModel("gpt-4o")).toBe(true);
    expect(isSelectableOpenAiModel("gpt-5")).toBe(true);
    expect(isSelectableOpenAiModel("o1")).toBe(true);
    expect(isSelectableOpenAiModel("o3")).toBe(true);
    expect(isSelectableOpenAiModel("o4-mini")).toBe(true);
  });

  it("rejects non-chat variants that share a prefix", () => {
    expect(isSelectableOpenAiModel("text-embedding-3-large")).toBe(false);
    expect(isSelectableOpenAiModel("gpt-4o-audio-preview")).toBe(false);
    expect(isSelectableOpenAiModel("gpt-4o-realtime-preview")).toBe(false);
    expect(isSelectableOpenAiModel("gpt-4o-transcribe")).toBe(false);
    expect(isSelectableOpenAiModel("gpt-image-1")).toBe(false);
    expect(isSelectableOpenAiModel("gpt-4o-search-preview")).toBe(false);
    expect(isSelectableOpenAiModel("dall-e-3")).toBe(false);
  });
});

describe("parseOpenAiModels", () => {
  it("maps the OpenAI list shape into ModelInfo, filtering non-chat models, newest first", () => {
    const models = parseOpenAiModels({
      object: "list",
      data: [
        { id: "gpt-4.1", object: "model", created: 1_700_000_000, owned_by: "openai" },
        { id: "text-embedding-3-small", object: "model", created: 1_650_000_000 },
        { id: "gpt-5", object: "model", created: 1_800_000_000, owned_by: "openai" },
      ],
    });

    expect(models.map((model) => model.id)).toEqual(["gpt-5", "gpt-4.1"]);
    expect(models[0]).toMatchObject({ id: "gpt-5", displayName: "gpt-5" });
    expect(models[0]?.createdAt).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });

  it("returns an empty list for a malformed or empty payload", () => {
    expect(parseOpenAiModels({})).toEqual([]);
    expect(parseOpenAiModels(null)).toEqual([]);
    expect(parseOpenAiModels({ data: "nope" })).toEqual([]);
  });
});

describe("mergeModels with the OpenAI catalog", () => {
  it("keeps live entries and fills gaps from the static catalog, de-duped by id", () => {
    const merged = mergeModels(
      [{ id: "gpt-4.1", displayName: "GPT-4.1 (live)" }],
      OPENAI_MODEL_CATALOG,
    );

    // Live entry wins on id; the rest of the catalog is appended.
    expect(merged.find((model) => model.id === "gpt-4.1")?.displayName).toBe("GPT-4.1 (live)");
    expect(merged.filter((model) => model.id === "gpt-4.1")).toHaveLength(1);
    expect(merged.some((model) => model.id === "gpt-5")).toBe(true);
  });
});
