import { describe, expect, it } from "vitest";

import { applyActions, emptySchema } from "../src/index.js";
import type { Schema } from "../src/model.js";

function makeTestIds() {
  let counter = 0;
  return () => `id-${++counter}`;
}

function seedSchema(makeId: () => string): Schema {
  const usersId = makeId();
  const postsId = makeId();
  const userIdField = makeId();
  const postIdField = makeId();
  const authorIdField = makeId();

  return {
    tables: [
      {
        id: usersId,
        name: "users",
        x: 0,
        y: 0,
        fields: [
          { id: userIdField, name: "id", type: "integer", pk: true, fk: false },
          { id: makeId(), name: "email", type: "text", pk: false, fk: false },
        ],
      },
      {
        id: postsId,
        name: "posts",
        x: 280,
        y: 0,
        fields: [
          { id: postIdField, name: "id", type: "integer", pk: true, fk: false },
          { id: authorIdField, name: "author_id", type: "integer", pk: false, fk: true },
        ],
      },
    ],
    relationships: [
      {
        id: makeId(),
        fromTable: postsId,
        fromField: authorIdField,
        toTable: usersId,
        toField: userIdField,
        cardinality: "1:N",
      },
    ],
  };
}

describe("applyActions", () => {
  describe("add_table", () => {
    it("adds a table with cascade position and default field values", () => {
      const makeId = makeTestIds();
      const result = applyActions(emptySchema(), [{ op: "add_table", name: "orders" }], {
        makeId,
      });

      expect(result.rejected).toEqual([]);
      expect(result.applied).toEqual([{ op: "add_table", tableIds: ["id-1"] }]);
      expect(result.schema.tables).toHaveLength(1);
      expect(result.schema.tables[0]).toMatchObject({
        id: "id-1",
        name: "orders",
        x: 0,
        y: 0,
        fields: [],
      });
    });

    it("rejects duplicate table names case-insensitively", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(schema, [{ op: "add_table", name: "Users" }], { makeId });

      expect(result.schema).toEqual(schema);
      expect(result.applied).toEqual([]);
      expect(result.rejected).toEqual([
        { action: { op: "add_table", name: "Users" }, reason: "table 'Users' already exists" },
      ]);
    });

    it("disambiguates duplicate field names so name-based ops stay unambiguous", () => {
      const makeId = makeTestIds();
      const result = applyActions(
        emptySchema(),
        [{ op: "add_table", name: "t", fields: [{ name: "id" }, { name: "id" }, { name: "ID" }] }],
        { makeId },
      );

      expect(result.rejected).toEqual([]);
      const names = result.schema.tables[0]!.fields.map((field) => field.name);
      expect(names).toEqual(["id", "id_2", "ID_3"]);
      // Case-insensitive uniqueness, matching findFieldByName's lookup.
      expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(names.length);
    });
  });

  describe("add_field", () => {
    it("adds a field with defaults", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(schema, [{ op: "add_field", table: "users", name: "name" }], {
        makeId,
      });

      expect(result.rejected).toEqual([]);
      expect(result.applied).toEqual([{ op: "add_field", tableIds: [schema.tables[0]!.id] }]);
      const users = result.schema.tables.find((table) => table.name === "users")!;
      expect(users.fields).toHaveLength(3);
      expect(users.fields[2]).toMatchObject({
        id: "id-8",
        name: "name",
        type: "text",
        pk: false,
        fk: false,
      });
    });

    it("rejects a missing table", () => {
      const makeId = makeTestIds();
      const schema = emptySchema();
      const result = applyActions(schema, [{ op: "add_field", table: "missing", name: "foo" }], {
        makeId,
      });

      expect(result.schema).toEqual(schema);
      expect(result.rejected[0]?.reason).toBe("table 'missing' not found");
    });

    it("rejects duplicate field names in the same table", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(schema, [{ op: "add_field", table: "users", name: "ID" }], {
        makeId,
      });

      expect(result.schema).toEqual(schema);
      expect(result.rejected[0]?.reason).toBe("field 'ID' already exists in table 'users'");
    });
  });

  describe("add_relationship", () => {
    it("adds a relationship with default cardinality and flags the from-field as fk", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(
        schema,
        [
          {
            op: "add_relationship",
            from_table: "posts",
            from_field: "id",
            to_table: "users",
            to_field: "id",
          },
        ],
        { makeId },
      );

      expect(result.rejected).toEqual([]);
      expect(result.schema.relationships).toHaveLength(2);
      expect(result.schema.relationships[1]).toMatchObject({
        id: "id-8",
        cardinality: "1:N",
      });
      const posts = result.schema.tables.find((table) => table.name === "posts")!;
      expect(posts.fields.find((field) => field.name === "id")?.fk).toBe(true);
    });

    it("rejects missing tables and fields", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);

      const missingTable = applyActions(
        schema,
        [
          {
            op: "add_relationship",
            from_table: "ghost",
            from_field: "id",
            to_table: "users",
            to_field: "id",
          },
        ],
        { makeId },
      );
      expect(missingTable.rejected[0]?.reason).toBe("table 'ghost' not found");

      const missingField = applyActions(
        schema,
        [
          {
            op: "add_relationship",
            from_table: "posts",
            from_field: "missing",
            to_table: "users",
            to_field: "id",
          },
        ],
        { makeId },
      );
      expect(missingField.rejected[0]?.reason).toBe("field 'missing' not found in table 'posts'");
    });

    it("rejects invalid cardinality at validation", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(
        schema,
        [
          {
            op: "add_relationship",
            from_table: "posts",
            from_field: "id",
            to_table: "users",
            to_field: "id",
            cardinality: "bad",
          },
        ],
        { makeId },
      );

      expect(result.schema).toEqual(schema);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]?.reason).toContain("Invalid enum value");
    });

    it("rejects duplicate relationships", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(
        schema,
        [
          {
            op: "add_relationship",
            from_table: "posts",
            from_field: "author_id",
            to_table: "users",
            to_field: "id",
          },
        ],
        { makeId },
      );

      expect(result.schema).toEqual(schema);
      expect(result.rejected[0]?.reason).toBe("relationship already exists");
    });
  });

  describe("remove_relationship", () => {
    it("removes the matching relationship by table/field names", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(
        schema,
        [
          {
            op: "remove_relationship",
            from_table: "posts",
            from_field: "author_id",
            to_table: "users",
            to_field: "id",
          },
        ],
        { makeId },
      );

      expect(result.rejected).toEqual([]);
      expect(result.schema.relationships).toEqual([]);
      expect(result.applied[0]).toMatchObject({ op: "remove_relationship" });
    });

    it("rejects when no matching relationship exists", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(
        schema,
        [
          {
            op: "remove_relationship",
            from_table: "users",
            from_field: "email",
            to_table: "posts",
            to_field: "id",
          },
        ],
        { makeId },
      );

      expect(result.schema.relationships).toHaveLength(1);
      expect(result.rejected[0]?.reason).toContain("no relationship");
    });
  });

  describe("remove_table", () => {
    it("removes a table and cascades relationships", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const usersId = schema.tables[0]!.id;
      const result = applyActions(schema, [{ op: "remove_table", table: "users" }], { makeId });

      expect(result.rejected).toEqual([]);
      expect(result.schema.tables).toHaveLength(1);
      expect(result.schema.tables[0]?.name).toBe("posts");
      expect(result.schema.relationships).toEqual([]);
      expect(result.applied).toEqual([{ op: "remove_table", tableIds: [usersId] }]);
    });

    it("rejects removing a nonexistent table", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(schema, [{ op: "remove_table", table: "nope" }], { makeId });

      expect(result.schema).toEqual(schema);
      expect(result.rejected[0]?.reason).toBe("table 'nope' not found");
    });
  });

  describe("remove_field", () => {
    it("removes a field and cascades relationships", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const postsId = schema.tables[1]!.id;
      const result = applyActions(
        schema,
        [{ op: "remove_field", table: "posts", field: "author_id" }],
        { makeId },
      );

      expect(result.rejected).toEqual([]);
      expect(result.schema.tables[1]?.fields).toHaveLength(1);
      expect(result.schema.relationships).toEqual([]);
      expect(result.applied).toEqual([{ op: "remove_field", tableIds: [postsId] }]);
    });

    it("rejects removing a nonexistent field", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(
        schema,
        [{ op: "remove_field", table: "posts", field: "ghost" }],
        { makeId },
      );

      expect(result.schema).toEqual(schema);
      expect(result.rejected[0]?.reason).toBe("field 'ghost' not found in table 'posts'");
    });
  });

  describe("rename_table", () => {
    it("renames a table while preserving casing resolution", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const usersId = schema.tables[0]!.id;
      const result = applyActions(
        schema,
        [{ op: "rename_table", table: "USERS", new_name: "accounts" }],
        { makeId },
      );

      expect(result.rejected).toEqual([]);
      expect(result.schema.tables[0]?.name).toBe("accounts");
      expect(result.applied).toEqual([{ op: "rename_table", tableIds: [usersId] }]);
    });

    it("rejects rename collisions", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(
        schema,
        [{ op: "rename_table", table: "users", new_name: "Posts" }],
        { makeId },
      );

      expect(result.schema).toEqual(schema);
      expect(result.rejected[0]?.reason).toBe("table 'Posts' already exists");
    });
  });

  describe("rename_field", () => {
    it("renames a field with case-insensitive lookup", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const postsId = schema.tables[1]!.id;
      const result = applyActions(
        schema,
        [{ op: "rename_field", table: "POSTS", field: "AUTHOR_ID", new_name: "user_id" }],
        { makeId },
      );

      expect(result.rejected).toEqual([]);
      expect(result.schema.tables[1]?.fields[1]?.name).toBe("user_id");
      expect(result.applied).toEqual([{ op: "rename_field", tableIds: [postsId] }]);
    });

    it("allows a case-only rename of the same field", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(
        schema,
        [{ op: "rename_field", table: "posts", field: "author_id", new_name: "Author_ID" }],
        { makeId },
      );

      expect(result.rejected).toEqual([]);
      expect(result.schema.tables[1]?.fields[1]?.name).toBe("Author_ID");
    });

    it("rejects renaming onto another field's name", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(
        schema,
        [{ op: "rename_field", table: "posts", field: "author_id", new_name: "ID" }],
        { makeId },
      );

      expect(result.schema).toEqual(schema);
      expect(result.rejected[0]?.reason).toBe("field 'ID' already exists in table 'posts'");
    });

    it("rejects an empty new name and unknown fields", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(
        schema,
        [
          { op: "rename_field", table: "posts", field: "author_id", new_name: "  " },
          { op: "rename_field", table: "posts", field: "ghost", new_name: "x" },
        ],
        { makeId },
      );

      expect(result.schema).toEqual(schema);
      expect(result.rejected[0]?.reason).toBe("new field name must not be empty");
      expect(result.rejected[1]?.reason).toBe("field 'ghost' not found in table 'posts'");
    });
  });

  describe("fk flag maintenance", () => {
    it("clears fk when a field's last relationship is removed", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(
        schema,
        [
          {
            op: "remove_relationship",
            from_table: "posts",
            from_field: "author_id",
            to_table: "users",
            to_field: "id",
          },
        ],
        { makeId },
      );

      expect(result.rejected).toEqual([]);
      expect(result.schema.tables[1]?.fields[1]?.fk).toBe(false);
    });

    it("keeps fk while another relationship still uses the field", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(
        schema,
        [
          {
            op: "add_relationship",
            from_table: "posts",
            from_field: "author_id",
            to_table: "users",
            to_field: "email",
          },
          {
            op: "remove_relationship",
            from_table: "posts",
            from_field: "author_id",
            to_table: "users",
            to_field: "id",
          },
        ],
        { makeId },
      );

      expect(result.rejected).toEqual([]);
      expect(result.schema.relationships).toHaveLength(1);
      expect(result.schema.tables[1]?.fields[1]?.fk).toBe(true);
    });

    it("clears fk on other tables when a cascade removes the relationship", () => {
      const makeId = makeTestIds();

      const viaRemoveTable = applyActions(seedSchema(makeId), [
        { op: "remove_table", table: "users" },
      ]);
      const posts = viaRemoveTable.schema.tables.find((table) => table.name === "posts")!;
      expect(posts.fields[1]?.fk).toBe(false);

      const viaRemoveField = applyActions(seedSchema(makeTestIds()), [
        { op: "remove_field", table: "users", field: "id" },
      ]);
      const posts2 = viaRemoveField.schema.tables.find((table) => table.name === "posts")!;
      expect(posts2.fields[1]?.fk).toBe(false);
    });
  });

  describe("batch behavior", () => {
    it("supports intra-batch dependencies", () => {
      const makeId = makeTestIds();
      const result = applyActions(
        emptySchema(),
        [
          { op: "add_table", name: "tags", fields: [{ name: "id", type: "integer", pk: true }] },
          { op: "add_field", table: "tags", name: "label" },
          {
            op: "add_relationship",
            from_table: "tags",
            from_field: "id",
            to_table: "tags",
            to_field: "label",
            cardinality: "1:1",
          },
        ],
        { makeId },
      );

      expect(result.rejected).toEqual([]);
      expect(result.applied).toHaveLength(3);
      expect(result.schema.tables).toHaveLength(1);
      expect(result.schema.tables[0]?.fields).toHaveLength(2);
      expect(result.schema.relationships).toHaveLength(1);
    });

    it("applies valid actions and rejects invalid ones in the same batch", () => {
      const makeId = makeTestIds();
      const result = applyActions(
        emptySchema(),
        [
          { op: "add_table", name: "a" },
          { op: "add_table", name: "b" },
          { op: "add_table", name: "c" },
          { op: "remove_table", table: "missing" },
        ],
        { makeId },
      );

      expect(result.schema.tables).toHaveLength(3);
      expect(result.applied).toHaveLength(3);
      expect(result.rejected).toEqual([
        { action: { op: "remove_table", table: "missing" }, reason: "table 'missing' not found" },
      ]);
    });

    it("rejects unknown ops and non-array rawActions without throwing", () => {
      const makeId = makeTestIds();
      const schema = emptySchema();

      const unknownOp = applyActions(schema, [{ op: "explode" }], { makeId });
      expect(unknownOp.rejected).toHaveLength(1);
      expect(unknownOp.rejected[0]?.reason.length).toBeGreaterThan(0);

      const notArray = applyActions(schema, { op: "add_table", name: "x" }, { makeId });
      expect(notArray.schema).toEqual(schema);
      expect(notArray.rejected).toEqual([
        { action: { op: "add_table", name: "x" }, reason: "actions must be an array" },
      ]);
    });

    it("does not mutate the input schema", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const snapshot = structuredClone(schema);

      applyActions(
        schema,
        [
          { op: "add_table", name: "invoices" },
          { op: "remove_table", table: "users" },
        ],
        { makeId },
      );

      expect(schema).toEqual(snapshot);
    });
  });

  describe("set_pk", () => {
    it("sets and clears the primary-key flag on an existing field", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const usersId = schema.tables[0]!.id;

      const set = applyActions(
        schema,
        [{ op: "set_pk", table: "users", field: "email", pk: true }],
        {
          makeId,
        },
      );
      expect(set.rejected).toEqual([]);
      expect(set.applied).toEqual([{ op: "set_pk", tableIds: [usersId] }]);
      const email = set.schema.tables[0]!.fields.find((field) => field.name === "email")!;
      expect(email.pk).toBe(true);

      const clear = applyActions(
        set.schema,
        [{ op: "set_pk", table: "users", field: "id", pk: false }],
        {
          makeId,
        },
      );
      expect(clear.schema.tables[0]!.fields.find((field) => field.name === "id")!.pk).toBe(false);
    });

    it("matches table and field names case-insensitively", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);

      const result = applyActions(
        schema,
        [{ op: "set_pk", table: "Users", field: "Email", pk: true }],
        { makeId },
      );
      expect(result.rejected).toEqual([]);
      expect(result.schema.tables[0]!.fields.find((field) => field.name === "email")!.pk).toBe(
        true,
      );
    });

    it("rejects unknown table or field and leaves the schema untouched", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);

      const badTable = applyActions(
        schema,
        [{ op: "set_pk", table: "ghost", field: "id", pk: true }],
        {
          makeId,
        },
      );
      expect(badTable.applied).toEqual([]);
      expect(badTable.rejected).toEqual([
        {
          action: { op: "set_pk", table: "ghost", field: "id", pk: true },
          reason: "table 'ghost' not found",
        },
      ]);

      const badField = applyActions(
        schema,
        [{ op: "set_pk", table: "users", field: "ghost", pk: true }],
        {
          makeId,
        },
      );
      expect(badField.rejected).toEqual([
        {
          action: { op: "set_pk", table: "users", field: "ghost", pk: true },
          reason: "field 'ghost' not found in table 'users'",
        },
      ]);
      expect(badField.schema).toEqual(schema);
    });

    it("rejects a set_pk missing the pk boolean", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(schema, [{ op: "set_pk", table: "users", field: "id" }], {
        makeId,
      });
      expect(result.applied).toEqual([]);
      expect(result.rejected).toHaveLength(1);
    });
  });

  describe("set_type", () => {
    it("changes the type of an existing field", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const usersId = schema.tables[0]!.id;

      const result = applyActions(
        schema,
        [{ op: "set_type", table: "users", field: "email", type: "varchar" }],
        { makeId },
      );

      expect(result.rejected).toEqual([]);
      expect(result.applied).toEqual([{ op: "set_type", tableIds: [usersId] }]);
      expect(result.schema.tables[0]!.fields.find((field) => field.name === "email")!.type).toBe(
        "varchar",
      );
    });

    it("matches table and field names case-insensitively", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);

      const result = applyActions(
        schema,
        [{ op: "set_type", table: "Users", field: "Email", type: "int" }],
        { makeId },
      );
      expect(result.rejected).toEqual([]);
      expect(result.schema.tables[0]!.fields.find((field) => field.name === "email")!.type).toBe(
        "int",
      );
    });

    it("rejects unknown table or field and leaves the schema untouched", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);

      const badField = applyActions(
        schema,
        [{ op: "set_type", table: "users", field: "ghost", type: "int" }],
        { makeId },
      );
      expect(badField.applied).toEqual([]);
      expect(badField.rejected).toEqual([
        {
          action: { op: "set_type", table: "users", field: "ghost", type: "int" },
          reason: "field 'ghost' not found in table 'users'",
        },
      ]);
      expect(badField.schema).toEqual(schema);
    });

    it("rejects a set_type missing the type", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const result = applyActions(schema, [{ op: "set_type", table: "users", field: "id" }], {
        makeId,
      });
      expect(result.applied).toEqual([]);
      expect(result.rejected).toHaveLength(1);
    });
  });

  describe("set_cardinality", () => {
    it("changes the cardinality of the matching relationship by table/field names", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);
      const relationshipId = schema.relationships[0]!.id;

      const result = applyActions(
        schema,
        [
          {
            op: "set_cardinality",
            from_table: "posts",
            from_field: "author_id",
            to_table: "users",
            to_field: "id",
            cardinality: "N:M",
          },
        ],
        { makeId },
      );

      expect(result.rejected).toEqual([]);
      expect(result.applied[0]).toMatchObject({ op: "set_cardinality", relationshipId });
      expect(result.schema.relationships[0]!.cardinality).toBe("N:M");
    });

    it("matches table and field names case-insensitively", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);

      const result = applyActions(
        schema,
        [
          {
            op: "set_cardinality",
            from_table: "Posts",
            from_field: "Author_Id",
            to_table: "Users",
            to_field: "Id",
            cardinality: "1:1",
          },
        ],
        { makeId },
      );

      expect(result.rejected).toEqual([]);
      expect(result.schema.relationships[0]!.cardinality).toBe("1:1");
    });

    it("rejects when no matching relationship exists and leaves the schema untouched", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);

      const result = applyActions(
        schema,
        [
          {
            op: "set_cardinality",
            from_table: "users",
            from_field: "email",
            to_table: "posts",
            to_field: "id",
            cardinality: "N:M",
          },
        ],
        { makeId },
      );

      expect(result.applied).toEqual([]);
      expect(result.rejected[0]?.reason).toContain("no relationship");
      expect(result.schema).toEqual(schema);
    });

    it("rejects unknown tables or fields", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);

      const missingTable = applyActions(
        schema,
        [
          {
            op: "set_cardinality",
            from_table: "ghost",
            from_field: "author_id",
            to_table: "users",
            to_field: "id",
            cardinality: "1:1",
          },
        ],
        { makeId },
      );
      expect(missingTable.rejected[0]?.reason).toBe("table 'ghost' not found");

      const missingField = applyActions(
        schema,
        [
          {
            op: "set_cardinality",
            from_table: "posts",
            from_field: "missing",
            to_table: "users",
            to_field: "id",
            cardinality: "1:1",
          },
        ],
        { makeId },
      );
      expect(missingField.rejected[0]?.reason).toBe("field 'missing' not found in table 'posts'");
    });

    it("rejects invalid cardinality at validation", () => {
      const makeId = makeTestIds();
      const schema = seedSchema(makeId);

      const result = applyActions(
        schema,
        [
          {
            op: "set_cardinality",
            from_table: "posts",
            from_field: "author_id",
            to_table: "users",
            to_field: "id",
            cardinality: "bad",
          },
        ],
        { makeId },
      );

      expect(result.applied).toEqual([]);
      expect(result.rejected).toHaveLength(1);
      expect(result.schema).toEqual(schema);
    });
  });
});
