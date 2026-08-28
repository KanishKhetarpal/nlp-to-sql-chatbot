import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ConfigModule } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { SchemaModule } from '../schema/schema.module';
import { SqlSafetyModule } from '../sql-safety/sql-safety.module';
import { ExecutionModule } from './execution.module';
import { SchemaService } from '../schema/schema.service';
import { SqlValidatorService } from '../sql-safety/sql-validator.service';
import { QueryExecutorService } from './query-executor.service';
import { ResultFormatterService } from './result-formatter.service';
import { QueryExecutionError } from './execution.types';
import { DatabaseSchema } from '../schema/schema.types';

/**
 * Exercises validation and execution against a real Postgres, because the
 * guarantees being tested — read-only enforcement, statement timeouts, the
 * SQLSTATE codes the executor branches on — belong to the database, not to
 * this code. A mock would only assert that we agree with ourselves.
 *
 * Skipped when no database is reachable, so a clone without Docker running
 * still gets a green suite rather than a wall of connection errors.
 */
const canConnect = async (): Promise<boolean> => {
  const probe = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5433', 10),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: process.env.DB_NAME ?? 'nlp_to_sql',
    connectTimeoutMS: 2000,
  });

  try {
    await probe.initialize();
    await probe.destroy();
    return true;
  } catch {
    return false;
  }
};

describe('execution pipeline (integration)', () => {
  let moduleRef: TestingModule | undefined;
  let validator: SqlValidatorService;
  let executor: QueryExecutorService;
  let formatter: ResultFormatterService;
  let schema: DatabaseSchema;
  let available = false;

  beforeAll(async () => {
    available = await canConnect();
    if (!available) {
      console.warn(
        'Skipping execution integration tests: no database reachable. ' +
          'Run `docker compose up -d --wait` to include them.',
      );
      return;
    }

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule,
        DatabaseModule,
        SchemaModule,
        SqlSafetyModule,
        ExecutionModule,
      ],
    }).compile();
    await moduleRef.init();

    validator = moduleRef.get(SqlValidatorService);
    executor = moduleRef.get(QueryExecutorService);
    formatter = moduleRef.get(ResultFormatterService);
    schema = await moduleRef.get(SchemaService).getSchema();
  }, 30000);

  afterAll(async () => {
    await moduleRef?.close();
  });

  /** Runs the real pipeline: validate, then execute. */
  const run = async (sql: string) =>
    executor.execute(validator.validate(sql, schema));

  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) {
          return;
        }
        await fn();
      },
      timeout,
    );

  maybe('runs a validated query and returns real rows', async () => {
    const result = await run('SELECT id, country FROM customers');

    expect(result.rowCount).toBeGreaterThan(0);
    expect(result.columns).toEqual(['id', 'country']);
  });

  maybe('reads the seeded data correctly', async () => {
    const result = await run(
      "SELECT count(*) AS n FROM customers WHERE country = 'United Kingdom'",
    );

    // Two of the five seeded customers are in the UK.
    expect(String(result.rows[0].n)).toBe('2');
  });

  maybe('executes a join across tables', async () => {
    const result = await run(
      'SELECT c.first_name, o.total_amount FROM customers c JOIN orders o ON o.customer_id = c.id',
    );

    expect(result.columns).toEqual(['first_name', 'total_amount']);
    expect(result.rowCount).toBeGreaterThan(0);
  });

  maybe('executes the wrapped form of a set operation', async () => {
    // The validator rewrites a UNION into a wrapped query; that rewrite has to
    // be valid SQL, which only a real database can confirm.
    const result = await run(
      'SELECT id FROM customers UNION SELECT id FROM orders',
    );

    expect(result.rowCount).toBeGreaterThan(0);
  });

  maybe('returns an empty result without error', async () => {
    const result = await run(
      "SELECT id FROM customers WHERE country = 'Atlantis'",
    );

    expect(result.rowCount).toBe(0);
    expect(formatter.summarize(result)).toBe('No rows matched.');
  });

  maybe('enforces the row cap against the real table', async () => {
    const result = await run('SELECT * FROM customers LIMIT 2');

    expect(result.rowCount).toBe(2);
  });

  maybe('refuses a write at the database level', async () => {
    // Bypasses the validator deliberately: this asserts the second lock, the
    // read-only transaction, rather than the first.
    await expect(
      executor.execute({
        sql: 'CREATE TABLE integration_should_fail (id integer)',
        original: '',
        tables: [],
        rowLimit: 500,
        limitOrigin: 'author',
      }),
    ).rejects.toMatchObject({ reason: 'read_only' });
  });

  maybe(
    'cancels a query that runs past the timeout',
    async () => {
      // pg_sleep is refused by the validator, so it is issued directly to
      // prove the timeout itself fires and maps to the right reason.
      const slow = executor.execute({
        sql: 'SELECT pg_sleep(30)',
        original: '',
        tables: [],
        rowLimit: 500,
        limitOrigin: 'author',
      });

      await expect(slow).rejects.toBeInstanceOf(QueryExecutionError);
      await expect(slow).rejects.toMatchObject({ reason: 'timeout' });
    },
    30000,
  );

  maybe('leaves no settings behind on the pooled connection', async () => {
    // SET LOCAL is transaction-scoped; if it leaked, the next query on this
    // connection would inherit the read-only flag and the timeout.
    await run('SELECT id FROM customers');

    const dataSource = moduleRef!.get(DataSource);
    const rows = await dataSource.query<{ statement_timeout: string }[]>(
      'SHOW statement_timeout',
    );

    // Read the column by its real name and assert it is present, so this
    // cannot pass by reading undefined off the wrong key.
    expect(rows[0]).toHaveProperty('statement_timeout');
    expect(rows[0].statement_timeout).toBe('0');
  });
});
