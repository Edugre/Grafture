export type Field = {
  id: string;
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
};

export type Table = {
  id: string;
  name: string;
  x: number;
  y: number;
  fields: Field[];
};

export type RelationshipCardinality = "1:1" | "1:N" | "N:M";

export type Relationship = {
  id: string;
  fromTable: string;
  fromField: string;
  toTable: string;
  toField: string;
  cardinality: RelationshipCardinality;
};

export type Schema = {
  tables: Table[];
  relationships: Relationship[];
};

export const emptySchema = (): Schema => ({
  tables: [],
  relationships: [],
});
