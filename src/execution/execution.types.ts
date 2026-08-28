/** A completed query and what it returned. */
export interface QueryResult {
  /** Column names in select order, present even when no rows came back. */
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  /**
   * True when the row cap cut the result short, so a reader knows the answer
   * is a page rather than the whole story.
   */
  truncated: boolean;
  durationMs: number;
}

export type ExecutionFailure =
  /** The statement ran past the configured timeout and was cancelled. */
  | 'timeout'
  /** The database refused a write — the last line of defence, after validation. */
  | 'read_only'
  /** Anything else the database rejected. */
  | 'database_error';

export class QueryExecutionError extends Error {
  constructor(
    message: string,
    readonly reason: ExecutionFailure,
    /** The database's own words, kept for the audit trail. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'QueryExecutionError';
  }

  toResponse(): { error: string; reason: ExecutionFailure; message: string } {
    return {
      error: 'query_execution_failed',
      reason: this.reason,
      message: this.message,
    };
  }
}

/** One line in the audit trail. */
export interface QueryAuditEntry {
  at: string;
  conversationId?: string;
  question: string;
  /** The statement as executed, after validation rewrote it. */
  sql: string;
  tables: string[];
  outcome: 'succeeded' | 'rejected' | 'failed' | 'unanswerable';
  rowCount?: number;
  durationMs?: number;
  /** Violation codes for a rejection, or the failure reason for an error. */
  reason?: string;
}
