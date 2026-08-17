import { Injectable, Logger } from '@nestjs/common';
import {
  LlmClient,
  LlmCompletion,
  LlmCompletionRequest,
  LlmDescription,
} from './llm.types';

/**
 * A deterministic stand-in for a real model — the default provider.
 *
 * It exists so the service runs, and the whole pipeline can be exercised,
 * without credentials: contributors can clone, `docker compose up`, and drive
 * every layer except the generation itself. It answers by reading the first
 * table out of the schema in the prompt, which is enough to prove the prompt
 * reached it and that the response shape round-trips.
 *
 * It is not a model and does not pretend to be one — every answer says so.
 */
@Injectable()
export class StubLlmClient extends LlmClient {
  private readonly logger = new Logger(StubLlmClient.name);

  describe(): LlmDescription {
    return { provider: 'stub', model: 'stub-echo' };
  }

  complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    this.logger.warn(
      'LLM_PROVIDER=stub — returning a canned answer, not model output',
    );

    const table = this.firstTable(request.system.map((b) => b.text).join('\n'));
    const question = [...request.messages]
      .reverse()
      .find((message) => message.role === 'user')?.content;

    const text = request.jsonSchema
      ? JSON.stringify({
          answerable: table !== null,
          sql: table ? `SELECT * FROM ${table} LIMIT 10;` : '',
          explanation: table
            ? `Stub provider: no model was called. Returned a sample query against "${table}".` +
              (question ? ` The question was: ${question}` : '')
            : 'Stub provider: no model was called, and no table was found in the schema context.',
          tables: table ? [table] : [],
        })
      : 'Stub provider: no model was called.';

    return Promise.resolve({
      text,
      model: 'stub-echo',
      stopReason: 'end_turn',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });
  }

  /** Pulls the first table name out of the serialized DDL in the prompt. */
  private firstTable(systemText: string): string | null {
    return /CREATE (?:TABLE|VIEW)\s+([\w.]+)/.exec(systemText)?.[1] ?? null;
  }
}
