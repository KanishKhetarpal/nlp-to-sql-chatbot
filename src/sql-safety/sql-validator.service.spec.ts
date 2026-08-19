import { ConfigService } from '@nestjs/config';
import { SqlValidatorService } from './sql-validator.service';
import { SqlValidationError, ViolationCode } from './sql-validation.types';
import { DatabaseSchema, TableMetadata } from '../schema/schema.types';

const table = (name: string): TableMetadata => ({
  schema: 'public',
  name,
  kind: 'table',
  comment: null,
  primaryKey: ['id'],
  uniqueConstraints: [],
  foreignKeys: [],
  columns: [
    {
      name: 'id',
      position: 1,
      dataType: 'integer',
      isNullable: false,
      defaultValue: null,
      comment: null,
      isPrimaryKey: true,
    },
  ],
});

const schema: DatabaseSchema = {
  database: 'nlp_to_sql',
  schemas: ['public'],
  tables: [table('customers'), table('orders'), table('order_items')],
  introspectedAt: '2026-01-01T00:00:00.000Z',
};

describe('SqlValidatorService', () => {
  const build = (overrides: Partial<Record<string, unknown>> = {}) => {
    const configService = {
      get: jest.fn().mockReturnValue({
        maxRows: 500,
        allowedTables: [],
        deniedTables: [],
        ...overrides,
      }),
    } as unknown as ConfigService;

    return new SqlValidatorService(configService);
  };

  let service: SqlValidatorService;

  beforeEach(() => {
    service = build();
  });

  /** Runs validation and returns the violation codes it raised. */
  const codesFor = (sql: string, svc = service): ViolationCode[] => {
    try {
      svc.validate(sql, schema);
    } catch (error) {
      if (error instanceof SqlValidationError) {
        return error.violations.map((violation) => violation.code);
      }
      throw error;
    }

    return [];
  };

  describe('accepts legitimate read queries', () => {
    it.each([
      ['a simple count', 'SELECT count(*) FROM customers'],
      [
        'a filtered projection',
        "SELECT id, country FROM customers WHERE country = 'United Kingdom'",
      ],
      [
        'a join across tables',
        'SELECT c.id FROM customers c JOIN orders o ON o.customer_id = c.id',
      ],
      [
        'a CTE',
        'WITH recent AS (SELECT id FROM orders) SELECT * FROM recent',
      ],
      [
        'a scalar subquery',
        'SELECT (SELECT count(*) FROM orders) AS total FROM customers',
      ],
      ['a union', 'SELECT id FROM customers UNION SELECT id FROM orders'],
      ['an aggregate with grouping', 'SELECT country, count(*) FROM customers GROUP BY country'],
    ])('accepts %s', (_label, sql) => {
      expect(codesFor(sql)).toEqual([]);
    });
  });

  describe('rejects statements that write', () => {
    it.each([
      ['DELETE', 'DELETE FROM customers'],
      ['UPDATE', "UPDATE customers SET country = 'x'"],
      ['INSERT', 'INSERT INTO customers (id) VALUES (1)'],
      ['DROP', 'DROP TABLE customers'],
      ['TRUNCATE', 'TRUNCATE customers'],
      ['ALTER', 'ALTER TABLE customers ADD COLUMN x integer'],
      ['CREATE', 'CREATE TABLE evil (id integer)'],
    ])('rejects %s', (_label, sql) => {
      const codes = codesFor(sql);

      expect(codes.length).toBeGreaterThan(0);
      // Either it is not a select, or the parser refused it outright — both
      // are rejections, and which one is an implementation detail.
      expect(
        codes.includes('not_a_select') || codes.includes('unparseable'),
      ).toBe(true);
    });
  });

  describe('rejects the attacks a statement-type check alone would miss', () => {
    it('rejects a second statement smuggled after a valid one', () => {
      expect(codesFor('SELECT 1; DROP TABLE customers;')).toEqual([
        'multiple_statements',
      ]);
    });

    it('rejects SELECT ... INTO, which creates a table', () => {
      // Parses as a plain `select`; only the INTO target gives it away.
      expect(codesFor('SELECT * INTO evil FROM customers')).toContain(
        'select_into',
      );
    });

    it('rejects a write hidden inside a CTE', () => {
      const codes = codesFor(
        'WITH d AS (DELETE FROM customers RETURNING *) SELECT * FROM d',
      );

      expect(codes.length).toBeGreaterThan(0);
      expect(
        codes.includes('not_a_select') || codes.includes('unparseable'),
      ).toBe(true);
    });

    it('rejects a filesystem-reading function inside a SELECT', () => {
      // No table is referenced, so a table allow list would never see this.
      expect(codesFor("SELECT pg_read_file('/etc/passwd')")).toContain(
        'forbidden_function',
      );
    });

    it('rejects a sleep function used to stall the backend', () => {
      expect(codesFor('SELECT pg_sleep(10)')).toContain('forbidden_function');
    });

    it('rejects a forbidden function buried in a WHERE clause', () => {
      expect(
        codesFor('SELECT id FROM customers WHERE id > pg_sleep(5)'),
      ).toContain('forbidden_function');
    });

    it('rejects a forbidden function nested in a subquery', () => {
      expect(
        codesFor(
          'SELECT id FROM customers WHERE id IN (SELECT pg_terminate_backend(1))',
        ),
      ).toContain('forbidden_function');
    });

    it('rejects EXPLAIN, which executes the query under ANALYZE', () => {
      const codes = codesFor('EXPLAIN ANALYZE SELECT * FROM customers');

      expect(codes.length).toBeGreaterThan(0);
    });
  });

  describe('table boundaries', () => {
    it('rejects a table that is not in the introspected schema', () => {
      const codes = codesFor('SELECT * FROM pg_shadow');

      expect(codes).toContain('unknown_table');
    });

    it('names the offending table on the violation', () => {
      try {
        service.validate('SELECT * FROM secrets', schema);
        fail('expected a validation error');
      } catch (error) {
        expect(error).toBeInstanceOf(SqlValidationError);
        expect((error as SqlValidationError).violations[0].subject).toBe(
          'secrets',
        );
      }
    });

    it('does not mistake a CTE name for an unknown table', () => {
      // The parser lists CTE names alongside real tables; without subtracting
      // them every WITH query would be rejected.
      expect(
        codesFor(
          'WITH recent AS (SELECT id FROM orders) SELECT * FROM recent',
        ),
      ).toEqual([]);
    });

    it('enforces an allow list when one is configured', () => {
      const restricted = build({ allowedTables: ['customers'] });

      expect(codesFor('SELECT * FROM customers', restricted)).toEqual([]);
      expect(codesFor('SELECT * FROM orders', restricted)).toContain(
        'denied_table',
      );
    });

    it('enforces a deny list even for tables in the schema', () => {
      const restricted = build({ deniedTables: ['orders'] });

      expect(codesFor('SELECT * FROM orders', restricted)).toContain(
        'denied_table',
      );
    });

    it('applies the deny list ahead of the allow list', () => {
      const restricted = build({
        allowedTables: ['orders'],
        deniedTables: ['orders'],
      });

      expect(codesFor('SELECT * FROM orders', restricted)).toEqual([
        'denied_table',
      ]);
    });

    it('checks every table in a join, not just the first', () => {
      const restricted = build({ allowedTables: ['customers'] });

      expect(
        codesFor(
          'SELECT c.id FROM customers c JOIN orders o ON o.customer_id = c.id',
          restricted,
        ),
      ).toContain('denied_table');
    });
  });

  describe('row limits', () => {
    it('adds a limit when the query has none', () => {
      const result = service.validate('SELECT * FROM customers', schema);

      expect(result.limitOrigin).toBe('injected');
      expect(result.sql).toContain('LIMIT 500');
    });

    it("keeps the author's limit when it is within the cap", () => {
      const result = service.validate(
        'SELECT * FROM customers LIMIT 10',
        schema,
      );

      expect(result.limitOrigin).toBe('author');
      expect(result.sql).toContain('LIMIT 10');
    });

    it('clamps a limit that exceeds the cap', () => {
      const result = service.validate(
        'SELECT * FROM customers LIMIT 100000',
        schema,
      );

      expect(result.limitOrigin).toBe('clamped');
      expect(result.sql).toContain('LIMIT 500');
      expect(result.sql).not.toContain('100000');
    });

    it('wraps a set operation so the cap covers every branch', () => {
      // Attaching a LIMIT to the tree would bind it to the first branch only,
      // leaving the second half of the union unbounded.
      const result = service.validate(
        'SELECT id FROM customers UNION SELECT id FROM orders',
        schema,
      );

      expect(result.limitOrigin).toBe('wrapped');
      expect(result.sql).toMatch(/^SELECT \* FROM \(.*\) AS "bounded_query" LIMIT 500$/s);
    });

    it('honours a configured cap other than the default', () => {
      const tight = build({ maxRows: 25 });
      const result = tight.validate('SELECT * FROM customers', schema);

      expect(result.sql).toContain('LIMIT 25');
      expect(result.rowLimit).toBe(25);
    });

    it('produces SQL that still passes validation', () => {
      // The bounded query is what actually runs, so it has to be valid.
      const result = service.validate(
        'SELECT id FROM customers UNION SELECT id FROM orders',
        schema,
      );

      expect(codesFor(result.sql)).toEqual([]);
    });
  });

  describe('malformed input', () => {
    it('rejects an empty statement', () => {
      expect(codesFor('   ')).toEqual(['empty_statement']);
    });

    it('rejects text that is not SQL', () => {
      expect(codesFor('this is not sql at all')).toEqual(['unparseable']);
    });
  });

  describe('the result it returns', () => {
    it('reports the base tables the query reads', () => {
      const result = service.validate(
        'SELECT c.id FROM customers c JOIN orders o ON o.customer_id = c.id',
        schema,
      );

      expect(result.tables).toEqual(['customers', 'orders']);
    });

    it('keeps the original text alongside the query that will run', () => {
      const result = service.validate('SELECT * FROM customers', schema);

      expect(result.original).toBe('SELECT * FROM customers');
      expect(result.sql).not.toBe(result.original);
    });
  });

  describe('error reporting', () => {
    it('collects every violation rather than stopping at the first', () => {
      const codes = codesFor("SELECT pg_sleep(1) FROM nowhere");

      expect(codes).toContain('forbidden_function');
      expect(codes).toContain('unknown_table');
    });

    it('reports a repeated finding once', () => {
      // DELETE trips both the top-level type check and the tree walk.
      expect(codesFor('DELETE FROM customers')).toEqual(['not_a_select']);
    });

    it('serializes to a response body with the violations intact', () => {
      try {
        service.validate('SELECT * FROM secrets', schema);
        fail('expected a validation error');
      } catch (error) {
        const response = (error as SqlValidationError).toResponse();

        expect(response.error).toBe('sql_validation_failed');
        expect(response.violations).toHaveLength(1);
        expect(response.violations[0]).toMatchObject({
          code: 'unknown_table',
          subject: 'secrets',
        });
        expect(response.message).toContain('secrets');
      }
    });
  });
});
