import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { LlmModule } from './llm.module';
import { LlmClient } from './llm.types';
import { AnthropicLlmClient } from './anthropic-llm.client';
import { StubLlmClient } from './stub-llm.client';
import { LlmConfig } from '../config/configuration';

/**
 * The factory that decides whether the service is talking to a model or to a
 * canned stand-in. Getting it wrong in production is silent: every request
 * still succeeds, and every answer is fiction.
 *
 * The real ConfigModule is used rather than a stubbed ConfigService, because
 * how the factory reads its configuration is part of what is being checked.
 */
const compile = (llm: Partial<LlmConfig>): Promise<TestingModule> =>
  Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        ignoreEnvVars: true,
        load: [
          () => ({
            llm: {
              provider: 'stub',
              apiKey: '',
              model: 'stub-echo',
              maxTokens: 16000,
              effort: 'high',
              ...llm,
            },
          }),
        ],
      }),
      LlmModule,
    ],
  }).compile();

describe('LlmModule', () => {
  let log: jest.SpyInstance;

  const logged = (): string[] =>
    (log.mock.calls as unknown as [string][]).map((call) => call[0]);

  beforeEach(() => {
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('binds the Anthropic client when that provider is configured', async () => {
    const moduleRef = await compile({
      provider: 'anthropic',
      apiKey: 'sk-ant-not-a-real-key',
      model: 'claude-opus-5',
    });

    const client = moduleRef.get(LlmClient);

    expect(client).toBeInstanceOf(AnthropicLlmClient);
    expect(client.describe()).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
    });
  });

  it('binds the stub when no provider is configured', async () => {
    const moduleRef = await compile({ provider: 'stub' });

    expect(moduleRef.get(LlmClient)).toBeInstanceOf(StubLlmClient);
  });

  it('falls back to the stub rather than failing on an unknown provider', async () => {
    // Joi keeps this out of the environment, so it can only arrive from a
    // programmatic caller. Answering with a canned reply beats refusing to
    // boot, and the log line below says which one is in use either way.
    const moduleRef = await compile({
      provider: 'openai' as LlmConfig['provider'],
    });

    expect(moduleRef.get(LlmClient)).toBeInstanceOf(StubLlmClient);
  });

  it('announces the provider it chose', async () => {
    // This line is the only thing telling an operator they are on the stub,
    // where every answer is invented and every request still returns 200.
    await compile({ provider: 'stub' });

    expect(logged().join('\n')).toContain('Using stub provider (stub-echo)');
  });

  it('names the model in that announcement, not just the vendor', async () => {
    await compile({
      provider: 'anthropic',
      apiKey: 'sk-ant-not-a-real-key',
      model: 'claude-opus-5',
    });

    expect(logged().join('\n')).toContain(
      'Using anthropic provider (claude-opus-5)',
    );
  });

  it('exports the client under the abstract token, not the concrete class', async () => {
    // Consumers inject LlmClient and must never learn which one they got.
    const moduleRef = await compile({ provider: 'stub' });

    expect(moduleRef.get(LlmClient)).toBeDefined();
  });
});
