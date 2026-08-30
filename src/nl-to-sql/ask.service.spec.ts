import { Logger } from '@nestjs/common';
import { AskService } from './ask.service';
import { SqlGenerationService, GenerateResult } from './sql-generation.service';
import { QueryExecutorService } from '../execution/query-executor.service';
import { ResultFormatterService } from '../execution/result-formatter.service';
import { QueryAuditService } from '../execution/query-audit.service';
import {
  QueryExecutionError,
  QueryResult,
  QueryAuditEntry,
} from '../execution/execution.types';
import { Violation } from '../sql-safety/sql-validation.types';

/**
 * The pipeline decides what happens when a step says no, so each of its five
 * outcomes is asserted here along with the audit line it must leave behind.
 *
 * The end-to-end suite drives the happy path against a real database; what it
 * cannot do is force a timeout or a rejection on demand, which is exactly
 * where the interesting branches are.
 */
const generation = (
  overrides: Partial<GenerateResult['generation']> = {},
): GenerateResult['generation'] => ({
  answerable: true,
  sql: 'SELECT id FROM customers',
  explanation: 'Reads the customer ids.',
  tables: ['customers'],
  ...overrides,
});

const generated = (
  overrides: Partial<GenerateResult> = {},
): GenerateResult => ({
  conversationId: 'conv-1',
  generation: generation(),
  validation: {
    status: 'valid',
    sql: 'SELECT id FROM customers LIMIT 500',
    tables: ['customers'],
    rowLimit: 500,
    limitOrigin: 'injected',
  },
  model: 'claude-opus-5',
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  ...overrides,
});

const queryResult = (overrides: Partial<QueryResult> = {}): QueryResult => ({
  columns: ['id'],
  rows: [{ id: 1 }],
  rowCount: 1,
  truncated: false,
  durationMs: 7,
  ...overrides,
});

describe('AskService', () => {
  let service: AskService;
  let generate: jest.Mock;
  let execute: jest.Mock;
  let record: jest.Mock;
  let summarize: jest.Mock;
  let toTable: jest.Mock;

  /** The audit entry from the nth call, typed so assertions are not `any`. */
  const audited = (call = 0): Omit<QueryAuditEntry, 'at'> =>
    (record.mock.calls as unknown as [Omit<QueryAuditEntry, 'at'>][])[call][0];

  beforeEach(() => {
    generate = jest.fn();
    execute = jest.fn();
    record = jest.fn();
    summarize = jest.fn().mockReturnValue('1 row, 1 column');
    toTable = jest.fn().mockReturnValue('id\n--\n1');

    // The pipeline logs a warning on execution failure; keep the suite quiet.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    service = new AskService(
      { generate } as unknown as SqlGenerationService,
      { execute } as unknown as QueryExecutorService,
      { summarize, toTable } as unknown as ResultFormatterService,
      { record } as unknown as QueryAuditService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('when the schema cannot answer the question', () => {
    beforeEach(() => {
      generate.mockResolvedValue(
        generated({
          generation: generation({
            answerable: false,
            sql: '',
            explanation: 'No table records refunds.',
            tables: [],
          }),
          validation: { status: 'skipped' },
        }),
      );
    });

    it('reports it as unanswerable without running anything', async () => {
      const response = await service.ask({ question: 'How many refunds?' });

      expect(response.status).toBe('unanswerable');
      expect(response.sql).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
    });

    it('audits the refusal with the reason the model gave', async () => {
      await service.ask({ question: 'How many refunds?' });

      expect(audited()).toMatchObject({
        outcome: 'unanswerable',
        reason: 'No table records refunds.',
        sql: '',
        tables: [],
      });
    });
  });

  describe('when safety review rejects the query', () => {
    const violations: Violation[] = [
      { code: 'not_a_select', message: 'Only SELECT is allowed.' },
      { code: 'denied_table', message: 'Table is denied.', subject: 'secrets' },
    ];

    beforeEach(() => {
      generate.mockResolvedValue(
        generated({
          generation: generation({ sql: 'DELETE FROM secrets' }),
          validation: { status: 'rejected', violations },
        }),
      );
    });

    it('returns every violation rather than the first', async () => {
      const response = await service.ask({ question: 'Delete the secrets' });

      expect(response.status).toBe('rejected');
      expect(response.violations).toEqual(violations);
      expect(execute).not.toHaveBeenCalled();
    });

    it('reports the query as proposed, since nothing was rewritten', async () => {
      const response = await service.ask({ question: 'Delete the secrets' });

      expect(response.sql).toBe('DELETE FROM secrets');
    });

    it('audits every violation code, not just one', async () => {
      await service.ask({ question: 'Delete the secrets' });

      expect(audited()).toMatchObject({
        outcome: 'rejected',
        reason: 'not_a_select, denied_table',
      });
    });
  });

  describe('on a dry run', () => {
    beforeEach(() => generate.mockResolvedValue(generated()));

    it('returns the statement that would have run, and does not run it', async () => {
      const response = await service.ask({
        question: 'Show me customers',
        dryRun: true,
      });

      expect(response.status).toBe('dry_run');
      expect(response.sql).toBe('SELECT id FROM customers LIMIT 500');
      expect(response.result).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
    });

    it('is still audited — someone asked, and a query was produced', async () => {
      await service.ask({ question: 'Show me customers', dryRun: true });

      expect(record).toHaveBeenCalledTimes(1);
      expect(audited()).toMatchObject({
        outcome: 'dry_run',
        sql: 'SELECT id FROM customers LIMIT 500',
      });
    });
  });

  describe('when the query runs', () => {
    beforeEach(() => {
      generate.mockResolvedValue(generated());
      execute.mockResolvedValue(queryResult());
    });

    it('executes the validated statement, not the proposed one', async () => {
      await service.ask({ question: 'Show me customers' });

      expect(execute).toHaveBeenCalledWith({
        sql: 'SELECT id FROM customers LIMIT 500',
        original: 'SELECT id FROM customers',
        tables: ['customers'],
        rowLimit: 500,
        limitOrigin: 'injected',
      });
    });

    it('attaches the rows, a summary and a rendered table', async () => {
      const response = await service.ask({ question: 'Show me customers' });

      expect(response.status).toBe('answered');
      expect(response.result?.rowCount).toBe(1);
      expect(response.summary).toBe('1 row, 1 column');
      expect(response.table).toBe('id\n--\n1');
    });

    it('audits the row count and duration', async () => {
      await service.ask({ question: 'Show me customers' });

      expect(audited()).toMatchObject({
        outcome: 'succeeded',
        rowCount: 1,
        durationMs: 7,
      });
    });

    it('answers under the conversation the generator resolved', async () => {
      // A request with no conversation id still gets one, and the response
      // must carry that id rather than the (absent) requested one.
      const response = await service.ask({ question: 'Show me customers' });

      expect(response.conversationId).toBe('conv-1');
      expect(audited().conversationId).toBe('conv-1');
    });
  });

  describe('when the database refuses the query', () => {
    beforeEach(() => {
      generate.mockResolvedValue(generated());
      execute.mockRejectedValue(
        new QueryExecutionError(
          'Query exceeded the time limit.',
          'timeout',
          'canceling statement due to statement timeout',
        ),
      );
    });

    it('reports the failure instead of throwing', async () => {
      const response = await service.ask({ question: 'Show me customers' });

      expect(response.status).toBe('failed');
      expect(response.error).toEqual({
        reason: 'timeout',
        message: 'Query exceeded the time limit.',
      });
    });

    it('still reports the statement that was attempted', async () => {
      const response = await service.ask({ question: 'Show me customers' });

      expect(response.sql).toBe('SELECT id FROM customers LIMIT 500');
    });

    it('audits the failure reason', async () => {
      await service.ask({ question: 'Show me customers' });

      expect(audited()).toMatchObject({
        outcome: 'failed',
        reason: 'timeout',
      });
    });
  });
});
