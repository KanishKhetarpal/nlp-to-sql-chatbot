import { Injectable, Logger } from '@nestjs/common';
import { SchemaService } from '../schema/schema.service';
import { DatabaseSchema } from '../schema/schema.types';
import { LlmClient, LlmUsage } from '../llm/llm.types';
import { SqlValidatorService } from '../sql-safety/sql-validator.service';
import {
  LimitOrigin,
  SqlValidationError,
  Violation,
} from '../sql-safety/sql-validation.types';
import { ConversationService } from './conversation.service';
import { PromptBuilderService } from './prompt-builder.service';
import { SqlGeneration } from './nl-to-sql.types';

export interface GenerateRequest {
  question: string;
  /** Continues an existing conversation; omit to start a new one. */
  conversationId?: string;
  /** Which API key is asking, so the conversation belongs to that caller. */
  clientId?: string;
}

/**
 * What safety review made of the proposed query.
 *
 * A rejection is a result, not an exception: the caller still wants to show
 * what was generated and say why it will not run.
 */
export type ValidationOutcome =
  | {
      status: 'valid';
      /** The bounded statement that is safe to execute. */
      sql: string;
      tables: string[];
      rowLimit: number;
      limitOrigin: LimitOrigin;
    }
  | { status: 'rejected'; violations: Violation[] }
  /** No query was produced, so there was nothing to check. */
  | { status: 'skipped' };

export interface GenerateResult {
  conversationId: string;
  generation: SqlGeneration;
  validation: ValidationOutcome;
  /** The model that actually answered — a fallback can change it. */
  model: string;
  usage: LlmUsage;
}

/** The provider replied, but not with the answer shape that was requested. */
export class MalformedGenerationError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'MalformedGenerationError';
  }
}

/**
 * Turns a natural-language question into a proposed SQL query.
 *
 * The orchestration layer: resolve the conversation, fetch the schema, build
 * the prompt, call whichever provider is configured, check the answer shape,
 * and put the proposed query through safety review before recording the turn.
 *
 * It still does not execute anything. A `valid` outcome carries the bounded
 * statement that would be safe to run; running it is the execution layer's job.
 */
@Injectable()
export class SqlGenerationService {
  private readonly logger = new Logger(SqlGenerationService.name);

  constructor(
    private readonly schemaService: SchemaService,
    private readonly promptBuilder: PromptBuilderService,
    private readonly conversations: ConversationService,
    private readonly llm: LlmClient,
    private readonly validator: SqlValidatorService,
  ) {}

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const conversation = this.conversations.resolve(
      request.conversationId,
      request.clientId,
    );
    const schema = await this.schemaService.getSchema();

    const prompt = this.promptBuilder.build({
      question: request.question,
      schema,
      history: conversation.turns,
    });

    const completion = await this.llm.complete(prompt);
    const generation = this.parse(completion.text);
    const validation = this.review(generation, schema);

    this.conversations.record(conversation.id, {
      question: request.question,
      generation,
      askedAt: new Date().toISOString(),
    });

    this.logger.log(
      generation.answerable
        ? `Generated SQL over [${generation.tables.join(', ')}] (${completion.usage.outputTokens} output tokens)`
        : 'Question reported as unanswerable from the current schema',
    );

    return {
      conversationId: conversation.id,
      generation,
      validation,
      model: completion.model,
      usage: completion.usage,
    };
  }

  /**
   * Puts the proposed query through safety review.
   *
   * Nothing the model returns is trusted on its own: the prompt asks for a
   * bounded SELECT, and this is where that is actually enforced.
   */
  private review(
    generation: SqlGeneration,
    schema: DatabaseSchema,
  ): ValidationOutcome {
    if (!generation.answerable) {
      return { status: 'skipped' };
    }

    try {
      const validated = this.validator.validate(generation.sql, schema);

      return {
        status: 'valid',
        sql: validated.sql,
        tables: validated.tables,
        rowLimit: validated.rowLimit,
        limitOrigin: validated.limitOrigin,
      };
    } catch (error) {
      if (error instanceof SqlValidationError) {
        this.logger.warn(
          `Generated query failed validation: ${error.violations
            .map((violation) => violation.code)
            .join(', ')}`,
        );
        return { status: 'rejected', violations: error.violations };
      }

      throw error;
    }
  }

  /**
   * Validates the provider's answer rather than trusting it.
   *
   * Structured outputs make a malformed response unlikely on providers that
   * enforce the schema — but the LlmClient contract does not require that, so
   * the shape is checked here where every provider passes through.
   */
  private parse(text: string): SqlGeneration {
    const cleaned = this.stripCodeFence(text.trim());

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new MalformedGenerationError(
        'The provider did not return JSON',
        text,
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new MalformedGenerationError(
        'The provider returned JSON, but not an object',
        text,
      );
    }

    const candidate = parsed as Record<string, unknown>;

    if (typeof candidate.answerable !== 'boolean') {
      throw new MalformedGenerationError('"answerable" is missing', text);
    }

    if (typeof candidate.sql !== 'string') {
      throw new MalformedGenerationError('"sql" is missing', text);
    }

    const sql = candidate.sql.trim();

    // An answerable verdict with no query is self-contradictory: downstream
    // would try to validate and run an empty statement.
    if (candidate.answerable && sql.length === 0) {
      throw new MalformedGenerationError(
        'The provider marked the question answerable but returned no SQL',
        text,
      );
    }

    return {
      answerable: candidate.answerable,
      sql: candidate.answerable ? sql : '',
      explanation:
        typeof candidate.explanation === 'string' ? candidate.explanation : '',
      tables: Array.isArray(candidate.tables)
        ? candidate.tables.filter(
            (table): table is string => typeof table === 'string',
          )
        : [],
    };
  }

  /** Tolerates a ```json fence, which some providers add around JSON. */
  private stripCodeFence(text: string): string {
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text);
    return fenced ? fenced[1].trim() : text;
  }
}
