/**
 * Shape of the database metadata the rest of the application reasons about.
 *
 * This is deliberately a plain data structure rather than TypeORM's own
 * metadata: it describes whatever database the service is pointed at, which is
 * not a database this application owns or has entities for.
 */

export type TableKind =
  | 'table'
  | 'view'
  | 'materialized_view'
  | 'partitioned_table';

export interface ColumnMetadata {
  name: string;
  /** 1-based ordinal position within the table. */
  position: number;
  /** Fully qualified Postgres type, e.g. `character varying(100)`. */
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
  comment: string | null;
  isPrimaryKey: boolean;
}

export interface ForeignKeyMetadata {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
}

export interface UniqueConstraintMetadata {
  name: string;
  columns: string[];
}

export interface TableMetadata {
  schema: string;
  name: string;
  kind: TableKind;
  comment: string | null;
  columns: ColumnMetadata[];
  primaryKey: string[];
  foreignKeys: ForeignKeyMetadata[];
  uniqueConstraints: UniqueConstraintMetadata[];
}

export interface DatabaseSchema {
  database: string;
  schemas: string[];
  tables: TableMetadata[];
  /** ISO timestamp of when this snapshot was read from the database. */
  introspectedAt: string;
}
