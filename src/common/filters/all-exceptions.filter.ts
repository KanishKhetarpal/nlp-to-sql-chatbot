import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { SqlValidationError } from '../../sql-safety/sql-validation.types';
import { QueryExecutionError } from '../../execution/execution.types';
import { MalformedGenerationError } from '../../nl-to-sql/sql-generation.service';
import {
  LlmRefusalError,
  LlmTruncatedError,
  LlmUnavailableError,
} from '../../llm/llm.types';

/** Statuses at or above this are ours to apologise for, and worth a stack trace. */
const SERVER_ERROR_FLOOR = 500;

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  path: string;
  timestamp: string;
  [key: string]: unknown;
}

/**
 * Turns every error into a considered HTTP response.
 *
 * The pipeline reports its ordinary outcomes — refused, unanswerable, failed —
 * in the response body, so anything reaching this filter is genuinely
 * exceptional. Each of our own error types still gets a status that means
 * something, and everything else becomes a plain 500 whose body says nothing
 * about the internals: stack traces and driver messages go to the log, not to
 * the caller.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();

    const body = this.describe(exception, request.url);

    if (body.statusCode >= SERVER_ERROR_FLOOR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${body.statusCode}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} -> ${body.statusCode}: ${body.message}`,
      );
    }

    response.status(body.statusCode).json(body);
  }

  private describe(exception: unknown, path: string): ErrorBody {
    const at = {
      path,
      timestamp: new Date().toISOString(),
    };

    // Nest's own exceptions already carry a considered status and body —
    // 404s, the validation pipe's 400s, the guards' 401s and 429s.
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      const base =
        typeof payload === 'string'
          ? { message: payload }
          : (payload as Record<string, unknown>);

      return {
        statusCode: exception.getStatus(),
        error: exception.name,
        message: exception.message,
        ...base,
        ...at,
      };
    }

    if (exception instanceof SqlValidationError) {
      // 422: the request was well-formed, but the query it produced cannot be
      // run. Nothing about retrying it differently would help.
      return {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        ...exception.toResponse(),
        ...at,
      };
    }

    if (exception instanceof QueryExecutionError) {
      return {
        statusCode:
          exception.reason === 'timeout'
            ? HttpStatus.GATEWAY_TIMEOUT
            : HttpStatus.BAD_GATEWAY,
        ...exception.toResponse(),
        ...at,
      };
    }

    if (exception instanceof LlmUnavailableError) {
      // Retryable failures are 503 so a client backs off rather than treating
      // the question itself as the problem.
      return {
        statusCode: exception.retryable
          ? HttpStatus.SERVICE_UNAVAILABLE
          : HttpStatus.BAD_GATEWAY,
        error: 'llm_unavailable',
        message: exception.message,
        ...at,
      };
    }

    if (exception instanceof LlmRefusalError) {
      return {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        error: 'llm_refused',
        message: exception.message,
        category: exception.category,
        ...at,
      };
    }

    if (
      exception instanceof MalformedGenerationError ||
      exception instanceof LlmTruncatedError
    ) {
      return {
        statusCode: HttpStatus.BAD_GATEWAY,
        error: 'llm_bad_response',
        message: exception.message,
        ...at,
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'internal_error',
      // Deliberately generic: an unexpected error's own message may quote a
      // query, a connection string or a stack frame.
      message: 'An unexpected error occurred',
      ...at,
    };
  }
}
