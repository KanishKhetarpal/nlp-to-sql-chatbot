/**
 * The provider-agnostic contract every LLM backend implements.
 *
 * Nothing above this layer names a vendor: the SQL generator asks for a
 * completion and gets text back. Swapping providers, or dropping in the stub
 * for local development, is a module binding rather than a code change.
 */

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmSystemBlock {
  text: string;
  /**
   * Marks the end of the stable prefix. Providers that support prompt caching
   * cache up to and including this block; providers that don't ignore it.
   */
  cacheable?: boolean;
}

export interface LlmCompletionRequest {
  system: LlmSystemBlock[];
  messages: LlmMessage[];
  /**
   * JSON Schema the response must conform to. Providers that support
   * constrained decoding enforce it; others are expected to fall back to
   * instructing the model and validating afterwards.
   */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmCompletion {
  text: string;
  model: string;
  stopReason: string | null;
  usage: LlmUsage;
}

export interface LlmDescription {
  provider: string;
  model: string;
}

/**
 * Abstract class rather than a TypeScript interface so it can double as the
 * Nest injection token — an interface would vanish at compile time.
 */
export abstract class LlmClient {
  abstract complete(request: LlmCompletionRequest): Promise<LlmCompletion>;

  abstract describe(): LlmDescription;
}

/** The provider declined to answer. Distinct from a transport failure. */
export class LlmRefusalError extends Error {
  constructor(
    readonly category: string | null,
    explanation?: string | null,
  ) {
    super(explanation ?? `The model declined to answer (${category ?? 'unspecified'})`);
    this.name = 'LlmRefusalError';
  }
}

/** The provider could not be reached, or rejected the request. */
export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

/** The response arrived but was cut off before it was complete. */
export class LlmTruncatedError extends Error {
  constructor(maxTokens: number) {
    super(
      `The model hit the ${maxTokens}-token output limit before finishing. Raise LLM_MAX_TOKENS.`,
    );
    this.name = 'LlmTruncatedError';
  }
}
