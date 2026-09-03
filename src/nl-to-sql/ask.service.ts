import { Injectable, Logger } from '@nestjs/common';
import { QueryExecutorService } from '../execution/query-executor.service';
import { ResultFormatterService } from '../execution/result-formatter.service';
import { QueryAuditService } from '../execution/query-audit.service';
import { QueryExecutionError, QueryResult } from '../execution/execution.types';
import { Violation } from '../sql-safety/sql-validation.types';
import { SqlGenerationService } from './sql-generation.service';
import { SqlGeneration } from './nl-to-sql.types';

export interface AskRequest {
  question: string;
  conversationId?: string;
  /**
   * Stop after generating and checking the query. Useful for showing someone
   * what would run before it runs.
   */
  dryRun?: boolean;
  /**
   * Which API key is asking. Carried through so the conversation and the
   * audit line belong to that caller and not to everyone.
   */
  clientId?: string;
}

export type AskStatus =
  /** Query ran; rows are attached. */
  | 'answered'
  /** The schema cannot answer the question. */
  | 'unanswerable'
  /** The generated query failed safety review. */
  | 'rejected'
  /** The query was valid but the database refused or timed out. */
  | 'failed'
  /** Validated only, by request. */
  | 'dry_run';

export interface AskResponse {
  status: AskStatus;
  conversationId: string;
  question: string;
  /** What the model proposed and why. */
  generation: SqlGeneration;
  /** The statement that ran, or would have run. */
  sql?: string;
  result?: QueryResult;
  /** A plain-language description of the result. */
  summary?: string;
  /** The result rendered as a fixed-width table. */
  table?: string;
  violations?: Violation[];
  error?: { reason: string; message: string };
  model: string;
}

/**
 * The end-to-end pipeline: question in, answer out.
 *
 * Generation, safety review, execution and formatting each own their step;
 * this is the seam that runs them in order, decides what to do when a step
 * says no, and makes sure every outcome — including the refusals — reaches the
 * audit trail.
 */
@Injectable()
export class AskService {
  private readonly logger = new Logger(AskService.name);

  constructor(
    private readonly generation: SqlGenerationService,
    private readonly executor: QueryExecutorService,
    private readonly formatter: ResultFormatterService,
    private readonly audit: QueryAuditService,
  ) {}

  async ask(request: AskRequest): Promise<AskResponse> {
    const generated = await this.generation.generate({
      question: request.question,
      conversationId: request.conversationId,
      clientId: request.clientId,
    });

    const base = {
      conversationId: generated.conversationId,
      question: request.question,
      generation: generated.generation,
      model: generated.model,
    };

    if (generated.validation.status === 'skipped') {
      this.audit.record({
        conversationId: base.conversationId,
        question: request.question,
        clientId: request.clientId,
        sql: '',
        tables: [],
        outcome: 'unanswerable',
        reason: generated.generation.explanation,
      });

      return { ...base, status: 'unanswerable' };
    }

    if (generated.validation.status === 'rejected') {
      this.audit.record({
        conversationId: base.conversationId,
        question: request.question,
        clientId: request.clientId,
        sql: generated.generation.sql,
        tables: generated.generation.tables,
        outcome: 'rejected',
        reason: generated.validation.violations
          .map((violation) => violation.code)
          .join(', '),
      });

      return {
        ...base,
        status: 'rejected',
        sql: generated.generation.sql,
        violations: generated.validation.violations,
      };
    }

    const { sql, tables } = generated.validation;

    if (request.dryRun) {
      // Audited like any other question: someone asked it and a query was
      // produced, which is what the trail is for. Only the execution is
      // skipped.
      this.audit.record({
        conversationId: base.conversationId,
        question: request.question,
        clientId: request.clientId,
        sql,
        tables,
        outcome: 'dry_run',
      });

      return { ...base, status: 'dry_run', sql };
    }

    try {
      const result = await this.executor.execute({
        sql,
        original: generated.generation.sql,
        tables,
        rowLimit: generated.validation.rowLimit,
        limitOrigin: generated.validation.limitOrigin,
      });

      this.audit.record({
        conversationId: base.conversationId,
        question: request.question,
        clientId: request.clientId,
        sql,
        tables,
        outcome: 'succeeded',
        rowCount: result.rowCount,
        durationMs: result.durationMs,
      });

      return {
        ...base,
        status: 'answered',
        sql,
        result,
        summary: this.formatter.summarize(result),
        table: this.formatter.toTable(result),
      };
    } catch (error) {
      if (error instanceof QueryExecutionError) {
        this.audit.record({
          conversationId: base.conversationId,
          question: request.question,
          clientId: request.clientId,
          sql,
          tables,
          outcome: 'failed',
          reason: error.reason,
        });

        this.logger.warn(`Execution failed (${error.reason}): ${error.detail}`);

        return {
          ...base,
          status: 'failed',
          sql,
          error: { reason: error.reason, message: error.message },
        };
      }

      // Anything else is a bug rather than a refusal, so it is rethrown for
      // the exception filter to turn into a 500. It is recorded first: an
      // unexpected failure is still an outcome, and it is the one a trail is
      // most useful for. Without this the statement that crashed the process
      // would be the only question in the day with no line explaining it.
      this.audit.record({
        conversationId: base.conversationId,
        question: request.question,
        clientId: request.clientId,
        sql,
        tables,
        outcome: 'failed',
        reason: 'unexpected_error',
      });

      throw error;
    }
  }
}
