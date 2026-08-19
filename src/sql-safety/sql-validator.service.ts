import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Parser } from 'node-sql-parser';
import { SqlSafetyConfig } from '../config/configuration';
import { DatabaseSchema } from '../schema/schema.types';
import {
  LimitOrigin,
  SqlValidationError,
  ValidatedSql,
  Violation,
} from './sql-validation.types';

const PARSER_OPTIONS = { database: 'PostgreSQL' } as const;

/**
 * Statement kinds that must never appear — at the top level or nested inside a
 * CTE or subquery. Postgres allows data-modifying CTEs, so checking only the
 * outermost statement type is not enough.
 *
 * EXPLAIN is here because EXPLAIN ANALYZE runs the query it is explaining.
 */
const FORBIDDEN_STATEMENT_TYPES = new Set([
  'alter',
  'analyze',
  'call',
  'comment',
  'copy',
  'create',
  'declare',
  'delete',
  'desc',
  'drop',
  'execute',
  'explain',
  'grant',
  'insert',
  'load',
  'lock',
  'prepare',
  'rename',
  'replace',
  'revoke',
  'set',
  'show',
  'transaction',
  'truncate',
  'update',
  'use',
]);

/**
 * Functions that read the filesystem, reach the network, stall the backend or
 * change server state. Each is a way to do damage from inside a plain SELECT,
 * where neither the statement type nor the table list would object.
 */
const FORBIDDEN_FUNCTIONS = new Set([
  'dblink',
  'dblink_exec',
  'lo_export',
  'lo_import',
  'pg_cancel_backend',
  'pg_logical_emit_message',
  'pg_ls_dir',
  'pg_read_binary_file',
  'pg_read_file',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_sleep',
  'pg_sleep_for',
  'pg_sleep_until',
  'pg_stat_file',
  'pg_terminate_backend',
  'query_to_xml',
  'set_config',
]);

interface ParsedStatement {
  ast: Record<string, unknown>;
  tableList: string[];
}

/**
 * Decides whether a proposed query is safe to run, and bounds it if so.
 *
 * Validation runs against a parsed syntax tree, never regular expressions over
 * the text. Comments, string literals, casing and whitespace all give a text
 * matcher somewhere to hide, and the interesting attacks live exactly there:
 * SELECT ... INTO is a plain select to a type check but creates a table, and a
 * data-modifying CTE hides a DELETE inside something that opens with WITH.
 *
 * The statement that comes back out is rebuilt from the tree that was checked,
 * so what executes is what was validated rather than the original text.
 */
@Injectable()
export class SqlValidatorService {
  private readonly logger = new Logger(SqlValidatorService.name);
  private readonly parser = new Parser();
  private readonly config: SqlSafetyConfig;

  constructor(configService: ConfigService) {
    this.config = configService.get<SqlSafetyConfig>('sqlSafety')!;
  }

  validate(sql: string, schema: DatabaseSchema): ValidatedSql {
    const original = sql.trim();

    if (original.length === 0) {
      throw new SqlValidationError(
        [{ code: 'empty_statement', message: 'No SQL statement was provided' }],
        original,
      );
    }

    // A parse failure is a rejection, not a warning: a statement this service
    // cannot read is a statement it cannot vouch for.
    const parsed = this.parse(original);
    const violations = this.dedupe([
      ...this.checkStatementShape(parsed.ast),
      ...this.checkFunctions(parsed.ast),
      ...this.checkTables(parsed, schema),
    ]);

    if (violations.length > 0) {
      this.logger.warn(
        `Rejected query: ${violations.map((v) => v.code).join(', ')}`,
      );
      throw new SqlValidationError(violations, original);
    }

    const bounded = this.enforceRowLimit(parsed.ast);

    return {
      sql: bounded.sql,
      original,
      tables: this.baseTables(parsed),
      rowLimit: this.config.maxRows,
      limitOrigin: bounded.limitOrigin,
    };
  }

  /**
   * Collapses repeats of the same finding. A DELETE trips both the top-level
   * statement check and the tree walk, and reporting it twice tells the reader
   * nothing the first one did not.
   */
  private dedupe(violations: Violation[]): Violation[] {
    const seen = new Set<string>();

    return violations.filter((violation) => {
      const key = `${violation.code}:${violation.subject ?? ''}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private parse(sql: string): ParsedStatement {
    let result: { ast: unknown; tableList: string[] };

    try {
      result = this.parser.parse(sql, PARSER_OPTIONS);
    } catch (error) {
      throw new SqlValidationError(
        [
          {
            code: 'unparseable',
            message: 'The statement is not valid PostgreSQL',
            subject:
              error instanceof Error ? error.message.split('\n')[0] : undefined,
          },
        ],
        sql,
      );
    }

    const statements = Array.isArray(result.ast) ? result.ast : [result.ast];

    // Stacked statements are the classic way to smuggle a second query past a
    // check that only inspects the first.
    if (statements.length > 1) {
      throw new SqlValidationError(
        [
          {
            code: 'multiple_statements',
            message: `Expected one statement, found ${statements.length}`,
          },
        ],
        sql,
      );
    }

    return {
      ast: statements[0] as Record<string, unknown>,
      tableList: result.tableList ?? [],
    };
  }

  private checkStatementShape(ast: Record<string, unknown>): Violation[] {
    const violations: Violation[] = [];

    if (ast.type !== 'select') {
      violations.push({
        code: 'not_a_select',
        message: `Only SELECT statements are allowed, got ${String(ast.type).toUpperCase()}`,
        subject: String(ast.type),
      });
    }

    for (const node of this.walk(ast)) {
      const type = typeof node.type === 'string' ? node.type : null;

      if (type && FORBIDDEN_STATEMENT_TYPES.has(type)) {
        violations.push({
          code: 'not_a_select',
          message: `${type.toUpperCase()} is not allowed, including inside a CTE or subquery`,
          subject: type,
        });
      }

      // SELECT ... INTO creates a table. The statement type stays "select",
      // so only the presence of a target names it for what it is.
      const into = node.into as { expr?: unknown } | undefined;
      if (into && into.expr) {
        violations.push({
          code: 'select_into',
          message: 'SELECT ... INTO creates a table and is not allowed',
          // A qualified target arrives as a node rather than a name; naming it
          // is a nicety, so skip it rather than print "[object Object]".
          subject: typeof into.expr === 'string' ? into.expr : undefined,
        });
      }
    }

    return violations;
  }

  private checkFunctions(ast: Record<string, unknown>): Violation[] {
    const violations: Violation[] = [];

    for (const name of this.functionNames(ast)) {
      if (FORBIDDEN_FUNCTIONS.has(name)) {
        violations.push({
          code: 'forbidden_function',
          message: `The function ${name}() is not allowed`,
          subject: name,
        });
      }
    }

    return violations;
  }

  private checkTables(
    parsed: ParsedStatement,
    schema: DatabaseSchema,
  ): Violation[] {
    const violations: Violation[] = [];
    const known = new Set(
      schema.tables.map((table) => table.name.toLowerCase()),
    );
    const allowed = new Set(this.config.allowedTables);
    const denied = new Set(this.config.deniedTables);

    for (const table of this.baseTables(parsed)) {
      if (denied.has(table)) {
        violations.push({
          code: 'denied_table',
          message: `Table "${table}" is on the deny list`,
          subject: table,
        });
        continue;
      }

      // An empty allow list means everything the schema exposes, so the
      // introspected schema is the default boundary.
      if (allowed.size > 0 && !allowed.has(table)) {
        violations.push({
          code: 'denied_table',
          message: `Table "${table}" is not on the allow list`,
          subject: table,
        });
        continue;
      }

      if (!known.has(table)) {
        violations.push({
          code: 'unknown_table',
          message: `Table "${table}" is not in the introspected schema`,
          subject: table,
        });
      }
    }

    return violations;
  }

  /**
   * Tables the query actually reads.
   *
   * The parser reports CTE names alongside real tables, so they are subtracted
   * here — otherwise every legitimate WITH query would be rejected for reading
   * a table that does not exist.
   */
  private baseTables(parsed: ParsedStatement): string[] {
    const cteNames = this.cteNames(parsed.ast);

    const tables = parsed.tableList
      .map((entry) => entry.split('::').pop() ?? '')
      .filter((name) => name.length > 0)
      .map((name) => name.toLowerCase())
      .filter((name) => !cteNames.has(name));

    return [...new Set(tables)].sort();
  }

  private cteNames(ast: Record<string, unknown>): Set<string> {
    const names = new Set<string>();

    for (const node of this.walk(ast)) {
      const withClause = node.with;
      if (!Array.isArray(withClause)) {
        continue;
      }

      for (const entry of withClause as { name?: { value?: unknown } }[]) {
        const value = entry?.name?.value;
        if (typeof value === 'string') {
          names.add(value.toLowerCase());
        }
      }
    }

    return names;
  }

  private functionNames(ast: Record<string, unknown>): string[] {
    const names: string[] = [];

    for (const node of this.walk(ast)) {
      if (node.type !== 'function' && node.type !== 'aggr_func') {
        continue;
      }

      const name = node.name;

      // A function name arrives either as a plain string or as a list of
      // parts, depending on whether the call was schema-qualified.
      if (typeof name === 'string') {
        names.push(name.toLowerCase());
      } else if (name && typeof name === 'object') {
        const parts = (name as { name?: { value?: unknown }[] }).name;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            const value = part?.value;
            if (typeof value === 'string') {
              names.push(value.toLowerCase());
            }
          }
        }
      }
    }

    return names;
  }

  /**
   * Applies the row cap.
   *
   * A set operation is wrapped rather than given a LIMIT directly: attaching
   * one to the tree binds it to the first branch, so a UNION would come back
   * capped on its first half and unbounded on the second.
   */
  private enforceRowLimit(ast: Record<string, unknown>): {
    sql: string;
    limitOrigin: LimitOrigin;
  } {
    const max = this.config.maxRows;

    if (ast._next) {
      const inner = this.parser.sqlify(ast as never, PARSER_OPTIONS);
      return {
        sql: `SELECT * FROM (${inner}) AS "bounded_query" LIMIT ${max}`,
        limitOrigin: 'wrapped',
      };
    }

    const limit = ast.limit as { value?: { value?: number }[] } | undefined;
    const current = limit?.value?.[0]?.value;

    let limitOrigin: LimitOrigin = 'author';

    if (typeof current !== 'number') {
      limitOrigin = 'injected';
    } else if (current > max) {
      limitOrigin = 'clamped';
    }

    if (limitOrigin !== 'author') {
      ast.limit = { seperator: '', value: [{ type: 'number', value: max }] };
    }

    return {
      sql: this.parser.sqlify(ast as never, PARSER_OPTIONS),
      limitOrigin,
    };
  }

  /** Depth-first walk over every object node in the tree. */
  private *walk(node: unknown): Generator<Record<string, unknown>> {
    if (Array.isArray(node)) {
      for (const item of node) {
        yield* this.walk(item);
      }
      return;
    }

    if (node === null || typeof node !== 'object') {
      return;
    }

    const record = node as Record<string, unknown>;
    yield record;

    for (const value of Object.values(record)) {
      yield* this.walk(value);
    }
  }
}
