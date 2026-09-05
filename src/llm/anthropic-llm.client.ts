import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { LlmConfig } from '../config/configuration';
import {
  LlmClient,
  LlmCompletion,
  LlmCompletionRequest,
  LlmDescription,
  LlmRefusalError,
  LlmTruncatedError,
  LlmUnavailableError,
} from './llm.types';

/**
 * Anthropic-backed implementation of {@link LlmClient}.
 *
 * Notes on the request shape, which is model-specific and easy to get wrong:
 *
 * - No `temperature` / `top_p` / `top_k`. Current models reject them outright;
 *   output is steered through the prompt instead.
 * - `thinking` is left unset, which means adaptive on this model family. It is
 *   deliberately not disabled: with thinking off the model can write a tool
 *   call into its visible text and leak internal tags into the response.
 * - `max_tokens` bounds thinking *and* answer together, so it is sized well
 *   above the length of the SQL we expect back.
 * - `timeout` and `maxRetries` are set explicitly. The SDK defaults to ten
 *   minutes per attempt, which would let an unresponsive provider hold a
 *   request open far longer than anything else in the pipeline: the database
 *   is bounded to ten seconds by comparison. Worst case is the timeout times
 *   one more than the retry count, so both are configured together.
 * - `fallbacks: 'default'` lets a request the safety classifiers decline be
 *   re-run server-side on Anthropic's recommended substitute, rather than
 *   surfacing as a failed question. A schema with tables named `users` or
 *   `credentials` is benign but sits close enough to sensitive territory that
 *   the occasional false positive is worth absorbing.
 */
@Injectable()
export class AnthropicLlmClient extends LlmClient {
  private readonly logger = new Logger(AnthropicLlmClient.name);
  private readonly client: Anthropic;
  private readonly config: LlmConfig;

  constructor(configService: ConfigService) {
    super();
    this.config = configService.get<LlmConfig>('llm')!;
    this.client = new Anthropic({
      apiKey: this.config.apiKey,
      timeout: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
    });
  }

  describe(): LlmDescription {
    return { provider: 'anthropic', model: this.config.model };
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    const maxTokens = request.maxTokens ?? this.config.maxTokens;

    const system = request.system.map((block) => ({
      type: 'text' as const,
      text: block.text,
      ...(block.cacheable
        ? { cache_control: { type: 'ephemeral' as const } }
        : {}),
    }));

    let response: Anthropic.Beta.Messages.BetaMessage;

    try {
      response = await this.client.beta.messages.create({
        model: this.config.model,
        max_tokens: maxTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        output_config: {
          effort: this.config.effort,
          ...(request.jsonSchema
            ? {
                format: {
                  type: 'json_schema' as const,
                  schema: request.jsonSchema,
                },
              }
            : {}),
        },
      });
    } catch (error) {
      throw this.translate(error);
    }

    // Checked before reading content: on a refusal the content array is empty
    // or holds only a partial answer, so indexing into it blindly would either
    // throw or return something misleading.
    if (response.stop_reason === 'refusal') {
      const details = response.stop_details;
      throw new LlmRefusalError(
        details && 'category' in details ? details.category : null,
        details && 'explanation' in details ? details.explanation : null,
      );
    }

    if (response.stop_reason === 'max_tokens') {
      throw new LlmTruncatedError(maxTokens);
    }

    const text = response.content
      .filter(
        (block): block is Anthropic.Beta.Messages.BetaTextBlock =>
          block.type === 'text',
      )
      .map((block) => block.text)
      .join('');

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };

    this.logger.debug(
      `${response.model}: ${usage.inputTokens} in / ${usage.outputTokens} out ` +
        `(${usage.cacheReadTokens} cached)`,
    );

    return {
      text,
      // Reported rather than assumed: a server-side fallback means the model
      // that answered is not necessarily the one that was asked.
      model: response.model,
      stopReason: response.stop_reason,
      usage,
    };
  }

  /** Maps SDK errors onto our own, so callers never import the vendor's. */
  private translate(error: unknown): Error {
    if (error instanceof Anthropic.RateLimitError) {
      return new LlmUnavailableError('Rate limited by the provider', true);
    }

    if (error instanceof Anthropic.AuthenticationError) {
      return new LlmUnavailableError('Provider rejected the API key', false);
    }

    if (error instanceof Anthropic.NotFoundError) {
      return new LlmUnavailableError(
        `Model "${this.config.model}" was not found`,
        false,
      );
    }

    if (error instanceof Anthropic.APIConnectionError) {
      return new LlmUnavailableError('Could not reach the provider', true);
    }

    if (error instanceof Anthropic.APIError) {
      return new LlmUnavailableError(
        `Provider error ${error.status ?? '(unknown status)'}: ${error.message}`,
        (error.status ?? 0) >= 500,
      );
    }

    return error instanceof Error ? error : new Error(String(error));
  }
}
