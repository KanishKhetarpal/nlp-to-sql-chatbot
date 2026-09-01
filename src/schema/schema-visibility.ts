import { DatabaseSchema, TableMetadata } from './schema.types';

export interface VisibilityRules {
  /** Empty means every introspected table is visible. */
  allowedTables: string[];
  deniedTables: string[];
}

/**
 * Narrows a schema snapshot to the tables this service is allowed to touch.
 *
 * The allow and deny lists were originally consulted in one place — safety
 * review, after the model had already been shown the whole schema and written
 * a query against it. That left the lists doing less than an operator would
 * assume: denying a table stopped it being *queried*, but its columns and
 * comments were still serialized into every prompt and still served by
 * `GET /schema`. A deny list that does not stop the metadata leaving the
 * building is not a deny list.
 *
 * Applying it here also improves the answers. A model shown a table it may not
 * read will happily write a correct query against it, and the person asking
 * gets a rejection instead of the "the schema cannot answer that" the pipeline
 * already knows how to say.
 *
 * Safety review still runs its own check. Two independent gates on the same
 * rule is the point: this one shapes what is offered, that one enforces what
 * is executed.
 */
export const applyVisibility = (
  schema: DatabaseSchema,
  rules: VisibilityRules,
): DatabaseSchema => {
  const denied = new Set(rules.deniedTables.map(normalize));
  const allowed = new Set(rules.allowedTables.map(normalize));

  if (denied.size === 0 && allowed.size === 0) {
    return schema;
  }

  const isVisible = (name: string): boolean => {
    const table = normalize(name);

    // Deny wins. A table on both lists is the case where someone has changed
    // their mind, and the safer reading of the two is the right one.
    if (denied.has(table)) {
      return false;
    }

    return allowed.size === 0 || allowed.has(table);
  };

  const tables = schema.tables
    .filter((table) => isVisible(table.name))
    .map((table) => withoutDanglingKeys(table, isVisible));

  // A new object every time: the caller's snapshot is the cached one, and
  // filtering it in place would leave the cache holding a narrowed copy that
  // no later configuration change could widen again.
  return { ...schema, tables };
};

/**
 * Drops foreign keys pointing at a table that is no longer visible.
 *
 * The serializer renders these as `REFERENCES <table>`, so leaving one behind
 * would name a hidden table in the prompt — and invite a join against
 * something the model cannot see the shape of.
 */
const withoutDanglingKeys = (
  table: TableMetadata,
  isVisible: (name: string) => boolean,
): TableMetadata => {
  const foreignKeys = table.foreignKeys.filter((key) =>
    isVisible(key.referencedTable),
  );

  return foreignKeys.length === table.foreignKeys.length
    ? table
    : { ...table, foreignKeys };
};

/** Table names are compared case-insensitively, as safety review compares them. */
const normalize = (name: string): string => name.trim().toLowerCase();
