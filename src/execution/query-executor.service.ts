import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { ExecutionConfig, SqlSafetyConfig } from '../config/configuration';
import { ValidatedSql } from '../sql-safety/sql-validation.types';
import { QueryExecutionError, QueryResult } from './execution.types';

/** Postgres cancelled the statement — what a statement_timeout looks like. */
const QUERY_CANCELED = '57014';
/** A write was attempted in a read-only transaction. */
const READ_ONLY_TRANSACTION = '25006';

interface StructuredResult {
  records: Record<string, unknown>[];
}

/**
 * Runs a validated query and returns its rows.
 *
 * Every statement runs inside a transaction that is explicitly marked
 * read-only and given a timeout. Validation has already refused anything that
 * writes, so this is the second lock on the same door: if a write ever reaches
 * here — through a parser gap or a future bug — the database refuses it rather
 * than trusting that the check upstream was perfect.
 *
 * A dedicated read-only database role is the stronger version of this, and is
 * what production should use; the transaction guard is what works with a
 * single connection and no extra setup.
 */
@Injectable()
export class QueryExecutorService {
  private readonly logger = new Logger(QueryExecutorService.name);
  private readonly execution: ExecutionConfig;
  private readonly safety: SqlSafetyConfig;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    configService: ConfigService,
  ) {
    this.execution = configService.get<ExecutionConfig>('execution')!;
    this.safety = configService.get<SqlSafetyConfig>('sqlSafety')!;
  }

  async execute(validated: ValidatedSql): Promise<QueryResult> {
    const runner = this.dataSource.createQueryRunner();
    const startedAt = Date.now();

    try {
      await runner.connect();
      await runner.startTransaction();

      // SET LOCAL scopes both settings to this transaction, so nothing leaks
      // onto the next borrower of this pooled connection.
      await runner.query('SET LOCAL transaction_read_only = on');
      await runner.query(
        `SET LOCAL statement_timeout = ${this.execution.timeoutMs}`,
      );

      const result = (await runner.query(
        validated.sql,
        [],
        true,
      )) as unknown as StructuredResult;

      await runner.rollbackTransaction();

      return this.shape(result, Date.now() - startedAt);
    } catch (error) {
      await this.rollbackQuietly(runner);
      throw this.translate(error);
    } finally {
      await runner.release();
    }
  }

  /**
   * Turns the driver's result into ours.
   *
   * Column names are taken from the first row, because TypeORM's Postgres
   * driver does not surface the underlying field metadata — its `raw` is the
   * row array itself. The consequence is that a result with no rows also has
   * no column names; the formatter says "No rows matched" rather than drawing
   * an empty table, so nothing depends on knowing them in that case.
   */
  private shape(result: StructuredResult, durationMs: number): QueryResult {
    const records = result.records ?? [];
    const columns = Object.keys(records[0] ?? {});

    // The validator already bounded the statement; this trims anything that
    // slipped past, so the cap holds even if the rewrite is ever wrong.
    const truncated = records.length > this.safety.maxRows;
    const rows = truncated ? records.slice(0, this.safety.maxRows) : records;

    if (truncated) {
      this.logger.warn(
        `Result exceeded the ${this.safety.maxRows}-row cap and was truncated`,
      );
    }

    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      durationMs,
    };
  }

  private async rollbackQuietly(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive) {
      return;
    }

    try {
      await runner.rollbackTransaction();
    } catch {
      // The transaction is already dead — a timeout aborts it server-side.
      // Nothing useful to do here, and it must not mask the original error.
    }
  }

  private translate(error: unknown): QueryExecutionError {
    const code = (error as { code?: string })?.code;
    const detail = error instanceof Error ? error.message : String(error);

    if (code === QUERY_CANCELED) {
      return new QueryExecutionError(
        `The query took longer than ${this.execution.timeoutMs}ms and was cancelled`,
        'timeout',
        detail,
      );
    }

    if (code === READ_ONLY_TRANSACTION) {
      return new QueryExecutionError(
        'The query attempted to write, which is not permitted',
        'read_only',
        detail,
      );
    }

    return new QueryExecutionError(
      'The database rejected the query',
      'database_error',
      detail,
    );
  }
}
