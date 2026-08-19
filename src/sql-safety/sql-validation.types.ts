/** Why a query was rejected. One code per distinct failure mode. */
export type ViolationCode =
  | 'empty_statement'
  | 'unparseable'
  | 'multiple_statements'
  | 'not_a_select'
  | 'select_into'
  | 'forbidden_function'
  | 'unknown_table'
  | 'denied_table';

export interface Violation {
  code: ViolationCode;
  message: string;
  /** The offending identifier, when one can be named. */
  subject?: string;
}

/** How the row cap ended up on the executed query. */
export type LimitOrigin =
  /** The query already had a limit within the cap. */
  | 'author'
  /** No limit was present; one was added. */
  | 'injected'
  /** The query asked for more rows than the cap allows. */
  | 'clamped'
  /** A set operation, wrapped so the cap covers every branch. */
  | 'wrapped';

export interface ValidatedSql {
  /** The statement to execute — rebuilt from the validated syntax tree. */
  sql: string;
  /** Exactly what the model proposed, kept for display and debugging. */
  original: string;
  /** Base tables the query reads, excluding CTE names. */
  tables: string[];
  rowLimit: number;
  limitOrigin: LimitOrigin;
}

/**
 * Raised when a query must not run. Carries every violation found rather than
 * the first, so a caller can explain all of what is wrong in one response.
 */
export class SqlValidationError extends Error {
  constructor(
    readonly violations: Violation[],
    readonly sql: string,
  ) {
    super(
      `Query rejected: ${violations.map((violation) => violation.message).join('; ')}`,
    );
    this.name = 'SqlValidationError';
  }

  /** Serializable form for an API error body. */
  toResponse(): {
    error: string;
    message: string;
    violations: Violation[];
  } {
    return {
      error: 'sql_validation_failed',
      message: this.message,
      violations: this.violations,
    };
  }
}
