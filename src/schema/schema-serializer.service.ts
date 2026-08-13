import { Injectable } from '@nestjs/common';
import { DatabaseSchema, TableMetadata } from './schema.types';

export interface SerializeOptions {
  /** Include table and column comments. Default true. */
  includeComments?: boolean;
  /**
   * Include column defaults. Default false — defaults rarely affect how a
   * SELECT should be written, and `nextval(...)` expressions are long.
   */
  includeDefaults?: boolean;
  /** Restrict output to these table names. Default: every table. */
  tables?: string[];
}

const DEFAULTS: Required<Omit<SerializeOptions, 'tables'>> = {
  includeComments: true,
  includeDefaults: false,
};

/**
 * Renders a DatabaseSchema as the DDL-shaped text that goes into an LLM
 * prompt.
 *
 * CREATE TABLE statements rather than prose or JSON: it is the form a model
 * has seen most often for this exact purpose, it states types and relations
 * without ambiguity, and it spends fewer tokens than an equivalent JSON dump
 * of the same metadata.
 *
 * Kept separate from introspection so prompt formatting can change — and be
 * tested — without touching how metadata is read.
 */
@Injectable()
export class SchemaSerializerService {
  serialize(schema: DatabaseSchema, options: SerializeOptions = {}): string {
    const opts = { ...DEFAULTS, ...options };

    // With a single schema in play, the prefix is noise on every identifier;
    // users and models both write `customers`, not `public.customers`.
    const qualify = schema.schemas.length > 1;

    const tables = options.tables
      ? schema.tables.filter((table) => options.tables!.includes(table.name))
      : schema.tables;

    const blocks = tables.map((table) =>
      this.serializeTable(table, qualify, opts),
    );

    return blocks.join('\n\n');
  }

  private serializeTable(
    table: TableMetadata,
    qualify: boolean,
    opts: Required<Omit<SerializeOptions, 'tables'>>,
  ): string {
    const lines: string[] = [];
    const name = qualify ? `${table.schema}.${table.name}` : table.name;

    if (opts.includeComments && table.comment) {
      lines.push(`-- ${table.comment}`);
    }

    const keyword = table.kind === 'table' ? 'CREATE TABLE' : 'CREATE VIEW';
    lines.push(`${keyword} ${name} (`);

    const body: string[] = [];

    for (const column of table.columns) {
      let definition = `  ${column.name} ${column.dataType}`;

      if (!column.isNullable) {
        definition += ' NOT NULL';
      }

      if (opts.includeDefaults && column.defaultValue) {
        definition += ` DEFAULT ${column.defaultValue}`;
      }

      body.push(definition);
    }

    // Constraints only mean something on a real table; a view has none.
    if (table.kind === 'table') {
      if (table.primaryKey.length > 0) {
        body.push(`  PRIMARY KEY (${table.primaryKey.join(', ')})`);
      }

      for (const unique of table.uniqueConstraints) {
        body.push(`  UNIQUE (${unique.columns.join(', ')})`);
      }

      for (const fk of table.foreignKeys) {
        const target = qualify
          ? `${fk.referencedSchema}.${fk.referencedTable}`
          : fk.referencedTable;

        body.push(
          `  FOREIGN KEY (${fk.columns.join(', ')})` +
            ` REFERENCES ${target} (${fk.referencedColumns.join(', ')})`,
        );
      }
    }

    // Comments ride on the line they describe so a model reading top to bottom
    // sees the column and its meaning together.
    const commented = body.map((line, index) => {
      const column = table.columns[index];
      const isColumnLine = index < table.columns.length;
      const suffix = index < body.length - 1 ? ',' : '';

      if (opts.includeComments && isColumnLine && column?.comment) {
        return `${line}${suffix} -- ${column.comment}`;
      }

      return `${line}${suffix}`;
    });

    lines.push(commented.join('\n'));
    lines.push(');');

    return lines.join('\n');
  }
}
