import { describe, expect, it } from "vitest";

import { emptySchema } from "../src/model.js";
import { toDbml, toPrisma, toSql } from "../src/export/index.js";

describe("export", () => {
  it("returns placeholder export strings", () => {
    const schema = emptySchema();

    expect(toDbml(schema)).toContain("DBML");
    expect(toSql(schema)).toContain("SQL");
    expect(toPrisma(schema)).toContain("Prisma");
  });
});
