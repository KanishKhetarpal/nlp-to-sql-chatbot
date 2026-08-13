import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IntrospectionConfig } from '../config/configuration';
import {
  ColumnMetadata,
  DatabaseSchema,
  ForeignKeyMetadata,
  TableKind,
  TableMetadata,
  UniqueConstraintMetadata,
} from './schema.types';

/** Relations worth exposing; sequences, indexes and toast tables are not. */
const RELKIND_TO_TABLE_KIND: Record<string, TableKind> = {
  r: 'table',
  v: 'view',
  m: 'materialized_view',
  p: 'partitioned_table',
};

interface TableRow {
  table_schema: string;
  table_name: string;
  relkind: string;
  table_comment: string | null;
}

interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  ordinal_position: number;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
  column_comment: string | null;
}

interface ConstraintRow {
  table_schema: string;
  table_name: string;
  constraint_name: string;
  constraint_type: 'p' | 'f' | 'u';
  column_names: string[] | null;
  referenced_schema: string | null;
  referenced_table: string | null;
  referenced_columns: string[] | null;
}

/**
 * Reads table, column and constraint metadata straight from the Postgres
 * system catalogs.
 *
 * It queries pg_catalog rather than information_schema because the catalogs
 * expose things the standard views do not: `format_type` renders the exact
 * declared type including precision, and `obj_description` / `col_description`
 * return the comments that make a schema legible to a language model.
 *
 * Every call hits the database. Caching is the caller's concern — see
 * SchemaCacheService.
 */
@Injectable()
export class SchemaIntrospectionService {
  private readonly logger = new Logger(SchemaIntrospectionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  private get schemas(): string[] {
    return this.configService.get<IntrospectionConfig>('introspection')!
      .schemas;
  }

  /** Reads a complete snapshot of the configured schemas. */
  async introspect(): Promise<DatabaseSchema> {
    const schemas = this.schemas;
    const startedAt = Date.now();

    const [tables, columns, constraints] = await Promise.all([
      this.fetchTables(schemas),
      this.fetchColumns(schemas),
      this.fetchConstraints(schemas),
    ]);

    const snapshot: DatabaseSchema = {
      database: this.dataSource.options.database as string,
      schemas,
      tables: this.assemble(tables, columns, constraints),
      introspectedAt: new Date().toISOString(),
    };

    this.logger.log(
      `Introspected ${snapshot.tables.length} relations from [${schemas.join(', ')}] in ${Date.now() - startedAt}ms`,
    );

    return snapshot;
  }

  /**
   * Joins the three flat result sets into one table-per-entry structure.
   * Done in memory rather than in SQL: a single query with array_agg over
   * columns and constraints is markedly harder to read for no real gain at
   * schema-sized row counts.
   */
  private assemble(
    tableRows: TableRow[],
    columnRows: ColumnRow[],
    constraintRows: ConstraintRow[],
  ): TableMetadata[] {
    const key = (schema: string, table: string) => `${schema}.${table}`;

    const columnsByTable = new Map<string, ColumnRow[]>();
    for (const row of columnRows) {
      const id = key(row.table_schema, row.table_name);
      const existing = columnsByTable.get(id);
      if (existing) {
        existing.push(row);
      } else {
        columnsByTable.set(id, [row]);
      }
    }

    const constraintsByTable = new Map<string, ConstraintRow[]>();
    for (const row of constraintRows) {
      const id = key(row.table_schema, row.table_name);
      const existing = constraintsByTable.get(id);
      if (existing) {
        existing.push(row);
      } else {
        constraintsByTable.set(id, [row]);
      }
    }

    return tableRows.map((table) => {
      const id = key(table.table_schema, table.table_name);
      const tableConstraints = constraintsByTable.get(id) ?? [];

      const primaryKey =
        tableConstraints.find((c) => c.constraint_type === 'p')?.column_names ??
        [];

      const foreignKeys: ForeignKeyMetadata[] = tableConstraints
        .filter((c) => c.constraint_type === 'f')
        .map((c) => ({
          name: c.constraint_name,
          columns: c.column_names ?? [],
          referencedSchema: c.referenced_schema as string,
          referencedTable: c.referenced_table as string,
          referencedColumns: c.referenced_columns ?? [],
        }));

      const uniqueConstraints: UniqueConstraintMetadata[] = tableConstraints
        .filter((c) => c.constraint_type === 'u')
        .map((c) => ({
          name: c.constraint_name,
          columns: c.column_names ?? [],
        }));

      const columns: ColumnMetadata[] = (columnsByTable.get(id) ?? []).map(
        (column) => ({
          name: column.column_name,
          position: column.ordinal_position,
          dataType: column.data_type,
          isNullable: column.is_nullable,
          defaultValue: column.column_default,
          comment: column.column_comment,
          isPrimaryKey: primaryKey.includes(column.column_name),
        }),
      );

      return {
        schema: table.table_schema,
        name: table.table_name,
        kind: RELKIND_TO_TABLE_KIND[table.relkind] ?? 'table',
        comment: table.table_comment,
        columns,
        primaryKey,
        foreignKeys,
        uniqueConstraints,
      };
    });
  }

  private fetchTables(schemas: string[]): Promise<TableRow[]> {
    return this.dataSource.query<TableRow[]>(
      `SELECT n.nspname                            AS table_schema,
              c.relname                            AS table_name,
              c.relkind::text                      AS relkind,
              obj_description(c.oid, 'pg_class')   AS table_comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = ANY($1::char[])
          AND n.nspname = ANY($2::text[])
        ORDER BY n.nspname, c.relname`,
      [Object.keys(RELKIND_TO_TABLE_KIND), schemas],
    );
  }

  private fetchColumns(schemas: string[]): Promise<ColumnRow[]> {
    return this.dataSource.query<ColumnRow[]>(
      `SELECT n.nspname                              AS table_schema,
              c.relname                              AS table_name,
              a.attname                              AS column_name,
              a.attnum                               AS ordinal_position,
              format_type(a.atttypid, a.atttypmod)   AS data_type,
              NOT a.attnotnull                       AS is_nullable,
              pg_get_expr(d.adbin, d.adrelid)        AS column_default,
              col_description(c.oid, a.attnum)       AS column_comment
         FROM pg_attribute a
         JOIN pg_class c     ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d   ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE a.attnum > 0
          AND NOT a.attisdropped
          AND c.relkind = ANY($1::char[])
          AND n.nspname = ANY($2::text[])
        ORDER BY n.nspname, c.relname, a.attnum`,
      [Object.keys(RELKIND_TO_TABLE_KIND), schemas],
    );
  }

  private fetchConstraints(schemas: string[]): Promise<ConstraintRow[]> {
    return this.dataSource.query<ConstraintRow[]>(
      `SELECT n.nspname        AS table_schema,
              c.relname        AS table_name,
              con.conname      AS constraint_name,
              con.contype::text AS constraint_type,
              -- attname is of type "name"; node-postgres has no array parser
              -- for name[], so cast to text[] to get a real JS array back.
              (SELECT array_agg(att.attname::text ORDER BY u.ord)
                 FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
                 JOIN pg_attribute att
                   ON att.attrelid = con.conrelid AND att.attnum = u.attnum
              )                AS column_names,
              fn.nspname       AS referenced_schema,
              fc.relname       AS referenced_table,
              (SELECT array_agg(att.attname::text ORDER BY u.ord)
                 FROM unnest(con.confkey) WITH ORDINALITY AS u(attnum, ord)
                 JOIN pg_attribute att
                   ON att.attrelid = con.confrelid AND att.attnum = u.attnum
              )                AS referenced_columns
         FROM pg_constraint con
         JOIN pg_class c      ON c.oid = con.conrelid
         JOIN pg_namespace n  ON n.oid = c.relnamespace
    LEFT JOIN pg_class fc     ON fc.oid = con.confrelid
    LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
        WHERE con.contype = ANY(ARRAY['p', 'f', 'u']::char[])
          AND n.nspname = ANY($1::text[])
        ORDER BY n.nspname, c.relname, con.conname`,
      [schemas],
    );
  }
}
