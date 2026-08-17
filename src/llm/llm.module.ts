import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmConfig } from '../config/configuration';
import { AnthropicLlmClient } from './anthropic-llm.client';
import { StubLlmClient } from './stub-llm.client';
import { LlmClient } from './llm.types';

/**
 * Binds the configured provider to the LlmClient token. Consumers inject the
 * abstract class and never learn which implementation they got.
 */
@Module({
  providers: [
    {
      provide: LlmClient,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): LlmClient => {
        const { provider } = configService.get<LlmConfig>('llm')!;

        const client =
          provider === 'anthropic'
            ? new AnthropicLlmClient(configService)
            : new StubLlmClient();

        const described = client.describe();
        new Logger('LlmModule').log(
          `Using ${described.provider} provider (${described.model})`,
        );

        return client;
      },
    },
  ],
  exports: [LlmClient],
})
export class LlmModule {}
