import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { SqlValidationError } from '../../sql-safety/sql-validation.types';
import { QueryExecutionError } from '../../execution/execution.types';
import { MalformedGenerationError } from '../../nl-to-sql/sql-generation.service';
import {
  LlmRefusalError,
  LlmTruncatedError,
  LlmUnavailableError,
} from '../../llm/llm.types';

/** The response body shape, mirrored here because the filter keeps it private. */
interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
  [key: string]: unknown;
}

/**
 * Every error a client ever sees comes through this filter, so what it maps to
 * which status — and what it refuses to say — is worth pinning exactly.
 *
 * The pipeline reports its ordinary outcomes in the response body, so anything
 * arriving here is genuinely exceptional and there is no happy path to lean on.
 */
describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;

  const capture = (
    exception: unknown,
    url = '/api/v1/chat/ask',
    method = 'POST',
  ): { status: number; body: ErrorBody } => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });

    filter.catch(exception, {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ url, method }),
      }),
    } as unknown as ArgumentsHost);

    const statusCalls = status.mock.calls as unknown as [number][];
    const jsonCalls = json.mock.calls as unknown as [ErrorBody][];

    return { status: statusCalls[0][0], body: jsonCalls[0][0] };
  };

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('every response', () => {
    it('says where and when, whatever went wrong', () => {
      const { body } = capture(new Error('boom'), '/api/v1/schema', 'GET');

      expect(body.path).toBe('/api/v1/schema');
      expect(Date.parse(body.timestamp)).not.toBeNaN();
    });

    it('sets the HTTP status to match the body it returns', () => {
      // A body claiming 422 sent with a 200 would be worse than either alone.
      const { status, body } = capture(new LlmRefusalError('policy'));

      expect(status).toBe(422);
      expect(body.statusCode).toBe(422);
    });
  });

  describe('exceptions Nest already considered', () => {
    it('keeps a 404 as a 404', () => {
      const { status, body } = capture(new NotFoundException());

      expect(status).toBe(404);
      expect(body.message).toBe('Not Found');
    });

    it('keeps the list of field errors from the validation pipe', () => {
      // The array is the useful part of a 400 — flattening it to a string
      // would leave the caller knowing only that something was wrong.
      const { body } = capture(
        new BadRequestException({
          statusCode: 400,
          message: [
            'question must be a string',
            'question should not be empty',
          ],
          error: 'Bad Request',
        }),
      );

      expect(body.message).toEqual([
        'question must be a string',
        'question should not be empty',
      ]);
    });

    it('handles an exception carrying a bare string payload', () => {
      const { status, body } = capture(new HttpException('I am a teapot', 418));

      expect(status).toBe(418);
      expect(body.message).toBe('I am a teapot');
    });
  });

  describe('a query that cannot be run', () => {
    const validation = new SqlValidationError(
      [{ code: 'not_a_select', message: 'Only SELECT is allowed.' }],
      'DELETE FROM customers',
    );

    it('is 422 — well-formed request, unrunnable query', () => {
      expect(capture(validation).status).toBe(422);
    });

    it('returns the violations, so the caller learns what was wrong', () => {
      const { body } = capture(validation);

      expect(body.error).toBe('sql_validation_failed');
      expect(body.violations).toEqual([
        { code: 'not_a_select', message: 'Only SELECT is allowed.' },
      ]);
    });
  });

  describe('a query the database refused', () => {
    it('is 504 on a timeout — the request outlived its budget', () => {
      expect(
        capture(new QueryExecutionError('Too slow.', 'timeout')).status,
      ).toBe(504);
    });

    it('is 502 when the database rejected it outright', () => {
      expect(
        capture(new QueryExecutionError('No writes.', 'read_only')).status,
      ).toBe(502);
      expect(
        capture(new QueryExecutionError('Syntax.', 'database_error')).status,
      ).toBe(502);
    });
  });

  describe('a provider that let us down', () => {
    it('is 503 when retrying might work', () => {
      // 503 tells a client to back off; 502 tells it the question is at fault.
      const { status, body } = capture(
        new LlmUnavailableError('Overloaded.', true),
      );

      expect(status).toBe(503);
      expect(body.error).toBe('llm_unavailable');
    });

    it('is 502 when retrying will not', () => {
      expect(
        capture(new LlmUnavailableError('Bad API key.', false)).status,
      ).toBe(502);
    });

    it('is 422 with the category when the model declined', () => {
      const { status, body } = capture(new LlmRefusalError('policy_violation'));

      expect(status).toBe(422);
      expect(body.error).toBe('llm_refused');
      expect(body.category).toBe('policy_violation');
    });

    it('is 502 when the answer came back unusable', () => {
      expect(
        capture(new MalformedGenerationError('Not JSON.', '{ oops')).status,
      ).toBe(502);
      expect(capture(new LlmTruncatedError(16000)).status).toBe(502);
      expect(capture(new LlmTruncatedError(16000)).body.error).toBe(
        'llm_bad_response',
      );
    });
  });

  describe('anything unexpected', () => {
    it('is a 500 that says nothing about the internals', () => {
      const leaky = new Error(
        'connect ECONNREFUSED 10.0.0.4:5432 while running SELECT * FROM salaries',
      );

      const { status, body } = capture(leaky);

      expect(status).toBe(500);
      expect(body.message).toBe('An unexpected error occurred');
      expect(JSON.stringify(body)).not.toContain('salaries');
      expect(JSON.stringify(body)).not.toContain('10.0.0.4');
    });

    it('survives something thrown that is not an Error at all', () => {
      const { status, body } = capture('a bare string');

      expect(status).toBe(500);
      expect(body.error).toBe('internal_error');
    });
  });

  describe('what reaches the log', () => {
    it('logs a server error with its stack, since it is ours to fix', () => {
      capture(new Error('boom'));

      expect(error).toHaveBeenCalledTimes(1);
      const calls = error.mock.calls as unknown as [string, string][];
      expect(calls[0][0]).toContain('POST /api/v1/chat/ask -> 500');
      expect(calls[0][1]).toContain('Error: boom');
    });

    it('logs a client error as a warning, without a stack', () => {
      capture(new NotFoundException(), '/nope', 'GET');

      expect(error).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      const calls = warn.mock.calls as unknown as [string][];
      expect(calls[0][0]).toContain('GET /nope -> 404');
    });

    it('logs the detail the caller is not told', () => {
      // The generic 500 body is only safe because the real cause is recorded
      // somewhere the operator can read it.
      capture(new Error('password authentication failed'));

      const calls = error.mock.calls as unknown as [string, string][];
      expect(calls[0][1]).toContain('password authentication failed');
    });
  });
});
