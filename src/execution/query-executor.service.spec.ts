import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { QueryExecutorService } from './query-executor.service';
import { QueryExecutionError } from './execution.types';
import { ValidatedSql } from '../sql-safety/sql-validation.types';

const validated = (sql = 'SELECT id FROM customers LIMIT 500'): ValidatedSql => ({
  sql,
  original: sql,
  tables: ['customers'],
  rowLimit: 500,
  limitOrigin: 'author',
});

/** A driver error carries a Postgres SQLSTATE, which is what we branch on. */
const pgError = (code: string) =>
  Object.assign(new Error(`pg said no (${code})`), { code });

describe('QueryExecutorService', () => {
  let query: jest.Mock;
  let runner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    query: jest.Mock;
    isTransactionActive: boolean;
  };
  let service: QueryExecutorService;

  const build = (overrides: Record<string, unknown> = {}) => {
    query = jest.fn().mockResolvedValue({ records: [] });

    runner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query,
      isTransactionActive: true,
    };

    const dataSource = {
      createQueryRunner: () => runner,
    } as unknown as DataSource;

    const configService = {
      get: jest.fn((key: string) =>
        key === 'execution'
          ? { timeoutMs: 10000, auditHistory: 200, ...overrides }
          : { maxRows: 500, allowedTables: [], deniedTables: [] },
      ),
    } as unknown as ConfigService;

    return new QueryExecutorService(dataSource, configService);
  };

  beforeEach(() => {
    service = build();
  });

  /** Statements issued before the query itself. */
  const preamble = () =>
    query.mock.calls.slice(0, 2).map((call) => String(call[0]));

  it('marks the transaction read-only before running anything', async () => {
    await service.execute(validated());

    expect(preamble()).toContain('SET LOCAL transaction_read_only = on');
  });

  it('applies the configured statement timeout', async () => {
    service = build({ timeoutMs: 2500 });

    await service.execute(validated());

    expect(preamble()).toContain('SET LOCAL statement_timeout = 2500');
  });

  it('scopes both settings to the transaction with SET LOCAL', async () => {
    // Without LOCAL these would persist on the pooled connection and affect
    // whatever ran next on it.
    await service.execute(validated());

    for (const statement of preamble()) {
      expect(statement.startsWith('SET LOCAL ')).toBe(true);
    }
  });

  it('runs the validated statement, not the original text', async () => {
    await service.execute({
      ...validated('SELECT id FROM customers LIMIT 500'),
      original: 'SELECT id FROM customers',
    });

    expect(String(query.mock.calls[2][0])).toBe(
      'SELECT id FROM customers LIMIT 500',
    );
  });

  it('rolls back rather than committing, since nothing should have changed', async () => {
    await service.execute(validated());

    expect(runner.rollbackTransaction).toHaveBeenCalled();
  });

  it('always releases the connection', async () => {
    query.mockRejectedValueOnce(pgError('42601'));

    await expect(service.execute(validated())).rejects.toBeInstanceOf(
      QueryExecutionError,
    );
    expect(runner.release).toHaveBeenCalled();
  });

  describe('shaping the result', () => {
    it('returns rows with their column names', async () => {
      query.mockResolvedValue({
        records: [
          { id: 1, country: 'UK' },
          { id: 2, country: 'US' },
        ],
      });

      const result = await service.execute(validated());

      expect(result.columns).toEqual(['id', 'country']);
      expect(result.rowCount).toBe(2);
      expect(result.truncated).toBe(false);
    });

    it('reports an empty result without inventing columns', async () => {
      const result = await service.execute(validated());

      expect(result.rows).toEqual([]);
      expect(result.columns).toEqual([]);
      expect(result.rowCount).toBe(0);
    });

    it('truncates anything past the row cap and says so', async () => {
      service = build();
      query.mockResolvedValue({
        records: Array.from({ length: 501 }, (_, index) => ({ id: index })),
      });

      const result = await service.execute(validated());

      expect(result.rowCount).toBe(500);
      expect(result.truncated).toBe(true);
    });

    it('measures how long the query took', async () => {
      const result = await service.execute(validated());

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('translating database errors', () => {
    it.each([
      ['57014', 'timeout'],
      ['25006', 'read_only'],
      ['42601', 'database_error'],
    ])('maps SQLSTATE %s to %s', async (code, reason) => {
      query.mockRejectedValueOnce(pgError(code));

      await expect(service.execute(validated())).rejects.toMatchObject({
        reason,
      });
    });

    it('keeps the database wording as detail without surfacing it as the message', async () => {
      query.mockRejectedValueOnce(pgError('57014'));

      try {
        await service.execute(validated());
        fail('expected an execution error');
      } catch (error) {
        const failure = error as QueryExecutionError;
        expect(failure.message).toContain('10000ms');
        expect(failure.detail).toContain('57014');
      }
    });

    it('survives a rollback that itself fails after a timeout', async () => {
      // A timed-out transaction is already dead server-side, so the rollback
      // can fail too — that must not replace the original error.
      query.mockRejectedValueOnce(pgError('57014'));
      runner.rollbackTransaction.mockRejectedValue(new Error('no transaction'));

      await expect(service.execute(validated())).rejects.toMatchObject({
        reason: 'timeout',
      });
    });
  });
});
