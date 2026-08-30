import { Logger } from '@nestjs/common';
import { StubLlmClient } from './stub-llm.client';
import { LlmCompletionRequest } from './llm.types';

const SCHEMA = `CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255)
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY
);`;

const request = (
  overrides: Partial<LlmCompletionRequest> = {},
): LlmCompletionRequest => ({
  system: [{ text: 'You write SQL.' }, { text: SCHEMA, cacheable: true }],
  messages: [{ role: 'user', content: 'How many customers are there?' }],
  jsonSchema: { type: 'object' },
  ...overrides,
});

interface StubAnswer {
  answerable: boolean;
  sql: string;
  explanation: string;
  tables: string[];
}

/**
 * The stub is the default provider, so a clone runs with no credentials. That
 * makes it the first thing a contributor meets, and the thing most likely to
 * be mistaken for a working model — hence the assertions that it announces
 * itself on every single call.
 */
describe('StubLlmClient', () => {
  let client: StubLlmClient;
  let warn: jest.SpyInstance;

  const answer = async (
    overrides: Partial<LlmCompletionRequest> = {},
  ): Promise<StubAnswer> => {
    const completion = await client.complete(request(overrides));
    return JSON.parse(completion.text) as StubAnswer;
  };

  beforeEach(() => {
    client = new StubLlmClient();
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('names itself rather than impersonating a model', () => {
    expect(client.describe()).toEqual({ provider: 'stub', model: 'stub-echo' });
  });

  it('warns on every call that the answer is canned', async () => {
    await client.complete(request());
    await client.complete(request());

    expect(warn).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls as unknown as [string][];
    expect(messages[0][0]).toContain('stub');
  });

  it('answers with the first table in the schema it was given', async () => {
    const parsed = await answer();

    expect(parsed).toMatchObject({
      answerable: true,
      sql: 'SELECT * FROM customers LIMIT 10;',
      tables: ['customers'],
    });
  });

  it('reads views as well as tables', async () => {
    const parsed = await answer({
      system: [{ text: 'CREATE VIEW active_customers (id INT);' }],
    });

    expect(parsed.tables).toEqual(['active_customers']);
  });

  it('echoes the question back, so the prompt is visibly reaching it', async () => {
    const parsed = await answer();

    expect(parsed.explanation).toContain('How many customers are there?');
  });

  it('uses the latest question when the conversation has history', async () => {
    const parsed = await answer({
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'an answer' },
        { role: 'user', content: 'second question' },
      ],
    });

    expect(parsed.explanation).toContain('second question');
    expect(parsed.explanation).not.toContain('first question');
  });

  it('reports unanswerable when the prompt carries no schema', async () => {
    const parsed = await answer({ system: [{ text: 'You write SQL.' }] });

    expect(parsed).toMatchObject({ answerable: false, sql: '', tables: [] });
  });

  it('returns plain text when no JSON schema was requested', async () => {
    const completion = await client.complete(
      request({ jsonSchema: undefined }),
    );

    expect(() => {
      JSON.parse(completion.text);
    }).toThrow();
    expect(completion.text).toContain('no model was called');
  });

  it('reports zero usage, because nothing was billed', async () => {
    const completion = await client.complete(request());

    expect(completion.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(completion.stopReason).toBe('end_turn');
  });
});
