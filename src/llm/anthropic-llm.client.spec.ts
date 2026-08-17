import { ConfigService } from '@nestjs/config';
import { AnthropicLlmClient } from './anthropic-llm.client';
import {
  LlmRefusalError,
  LlmTruncatedError,
  LlmUnavailableError,
} from './llm.types';

const mockCreate = jest.fn();

// The SDK is mocked so these tests assert the request we *send* — the part we
// control — without needing credentials or a network round trip.
jest.mock('@anthropic-ai/sdk', () => {
  class MockAPIError extends Error {
    constructor(
      readonly status: number | undefined,
      message: string,
    ) {
      super(message);
    }
  }
  class MockRateLimitError extends MockAPIError {}
  class MockAuthenticationError extends MockAPIError {}
  class MockNotFoundError extends MockAPIError {}
  class MockAPIConnectionError extends MockAPIError {}

  class MockAnthropic {
    beta = { messages: { create: mockCreate } };
    constructor(readonly options: { apiKey: string }) {}
  }

  return {
    __esModule: true,
    default: Object.assign(MockAnthropic, {
      APIError: MockAPIError,
      RateLimitError: MockRateLimitError,
      AuthenticationError: MockAuthenticationError,
      NotFoundError: MockNotFoundError,
      APIConnectionError: MockAPIConnectionError,
    }),
  };
});

// Imported after the mock is registered so the stubbed classes are in place.
import Anthropic from '@anthropic-ai/sdk';

const reply = (overrides: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5',
  stop_reason: 'end_turn',
  stop_details: null,
  content: [{ type: 'text', text: '{"answerable":true}' }],
  usage: {
    input_tokens: 1200,
    output_tokens: 80,
    cache_read_input_tokens: 1024,
    cache_creation_input_tokens: 0,
  },
  ...overrides,
});

describe('AnthropicLlmClient', () => {
  let client: AnthropicLlmClient;

  const build = (overrides: Record<string, unknown> = {}) => {
    const configService = {
      get: jest.fn().mockReturnValue({
        provider: 'anthropic',
        apiKey: 'test-key',
        model: 'claude-opus-5',
        maxTokens: 16000,
        effort: 'high',
        ...overrides,
      }),
    } as unknown as ConfigService;

    return new AnthropicLlmClient(configService);
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(reply());
    client = build();
  });

  const complete = () =>
    client.complete({
      system: [
        { text: 'You translate questions to SQL.' },
        { text: 'CREATE TABLE customers (id integer);', cacheable: true },
      ],
      messages: [{ role: 'user', content: 'How many customers?' }],
      jsonSchema: { type: 'object', properties: {} },
    });

  it('sends the configured model, effort and token ceiling', async () => {
    await complete();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const params = mockCreate.mock.calls[0][0] as Record<string, any>;

    expect(params.model).toBe('claude-opus-5');
    expect(params.max_tokens).toBe(16000);
    expect(params.output_config.effort).toBe('high');
  });

  it('never sends sampling parameters, which current models reject', async () => {
    await complete();
    const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;

    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('top_p');
    expect(params).not.toHaveProperty('top_k');
  });

  it('leaves thinking unset rather than disabling it', async () => {
    await complete();
    const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;

    expect(params).not.toHaveProperty('thinking');
  });

  it('opts into server-side fallbacks so a refusal is retried, not surfaced', async () => {
    await complete();
    const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;

    expect(params.fallbacks).toBe('default');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
  });

  it('passes the JSON schema through as a structured output format', async () => {
    await complete();
    const params = mockCreate.mock.calls[0][0] as Record<string, any>;

    expect(params.output_config.format).toEqual({
      type: 'json_schema',
      schema: { type: 'object', properties: {} },
    });
  });

  it('omits the format entirely when no schema is requested', async () => {
    await client.complete({
      system: [{ text: 'hello' }],
      messages: [{ role: 'user', content: 'hi' }],
    });

    const params = mockCreate.mock.calls[0][0] as Record<string, any>;
    expect(params.output_config).not.toHaveProperty('format');
  });

  it('marks only the cacheable system block for caching', async () => {
    await complete();
    const params = mockCreate.mock.calls[0][0] as Record<string, any>;

    expect(params.system[0]).not.toHaveProperty('cache_control');
    expect(params.system[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('returns the joined text, usage and the model that actually answered', async () => {
    mockCreate.mockResolvedValue(
      reply({
        model: 'claude-opus-4-8',
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: '{"sql":' },
          { type: 'text', text: '"SELECT 1"}' },
        ],
      }),
    );

    const result = await client.complete({
      system: [{ text: 'x' }],
      messages: [{ role: 'user', content: 'y' }],
    });

    expect(result.text).toBe('{"sql":"SELECT 1"}');
    expect(result.model).toBe('claude-opus-4-8');
    expect(result.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 1024,
      cacheWriteTokens: 0,
    });
  });

  it('raises a refusal before touching the content array', async () => {
    mockCreate.mockResolvedValue(
      reply({
        stop_reason: 'refusal',
        stop_details: { category: 'cyber', explanation: 'declined' },
        content: [],
      }),
    );

    await expect(complete()).rejects.toBeInstanceOf(LlmRefusalError);
    await expect(complete()).rejects.toMatchObject({ category: 'cyber' });
  });

  it('raises rather than returning a half-written answer', async () => {
    mockCreate.mockResolvedValue(reply({ stop_reason: 'max_tokens' }));

    await expect(complete()).rejects.toBeInstanceOf(LlmTruncatedError);
  });

  it.each([
    ['RateLimitError', 429, true],
    ['APIConnectionError', undefined, true],
    ['AuthenticationError', 401, false],
    ['NotFoundError', 404, false],
  ])('translates %s into a typed error', async (name, status, retryable) => {
    const ErrorClass = (Anthropic as unknown as Record<string, any>)[name];
    mockCreate.mockRejectedValue(new ErrorClass(status, 'boom'));

    await expect(complete()).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(complete()).rejects.toMatchObject({ retryable });
  });

  it('reports which provider and model it is configured for', () => {
    expect(client.describe()).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
    });
  });
});
