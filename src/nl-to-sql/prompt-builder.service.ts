import { Injectable } from '@nestjs/common';
import { SchemaSerializerService } from '../schema/schema-serializer.service';
import { DatabaseSchema } from '../schema/schema.types';
import { LlmCompletionRequest } from '../llm/llm.types';
import { ConversationTurn } from './nl-to-sql.types';

export interface PromptInput {
  question: string;
  schema: DatabaseSchema;
  history?: ConversationTurn[];
}

/**
 * The JSON shape the model must return.
 *
 * `answerable` is first-class rather than implied by an empty `sql`: a question
 * the schema genuinely cannot answer should come back as a clear "no, and
 * here's what's missing", not as a plausible query over the wrong columns.
 */
export const SQL_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    answerable: {
      type: 'boolean',
      description: 'Whether the question can be answered from this schema.',
    },
    sql: {
      type: 'string',
      description:
        'The PostgreSQL SELECT statement. Empty string when not answerable.',
    },
    explanation: {
      type: 'string',
      description:
        'One or two sentences: how the query answers the question, or what the schema is missing.',
    },
    tables: {
      type: 'array',
      items: { type: 'string' },
      description: 'Tables the query reads.',
    },
  },
  required: ['answerable', 'sql', 'explanation', 'tables'],
  additionalProperties: false,
};

const INSTRUCTIONS = `You translate natural-language questions into a single PostgreSQL query over the schema below.

How to write the query:
- Return exactly one statement, and make it a SELECT (a WITH clause ending in SELECT is fine). Statements that write, alter or drop are rejected before execution, so proposing one only costs the person their turn.
- Use only the tables and columns in the schema. If answering would need something that isn't there, set answerable to false and say what is missing — a plausible query over the wrong columns is worse than a clear no.
- List the columns the question asks for rather than selecting everything, so the result is readable.
- Add a LIMIT when the question implies a list of rows and names no bound. Leave it off for aggregates, which already return few rows.
- Qualify column names when more than one table is in play, and join on the foreign keys the schema declares.
- Read the column comments. They carry meaning the names don't, including which values a status column actually takes.
- When a question is ambiguous, choose the reading a person familiar with this data would mean, and say which reading you took in the explanation.

Follow-up questions refer to the conversation so far: resolve them against the previous question and query before answering.`;

/**
 * Assembles the prompt for one question.
 *
 * Kept separate from the generation service so the wording, the schema
 * rendering and the output contract can be changed and tested on their own —
 * prompt text is the part of an LLM feature most likely to need iteration.
 *
 * Block order matters for prompt caching: the instructions are fixed and the
 * schema changes only when the database does, so both sit ahead of the cache
 * breakpoint, while the question and history go into messages after it.
 */
@Injectable()
export class PromptBuilderService {
  constructor(private readonly serializer: SchemaSerializerService) {}

  build(input: PromptInput): LlmCompletionRequest {
    const ddl = this.serializer.serialize(input.schema);

    return {
      system: [
        { text: INSTRUCTIONS },
        {
          text: `Schema of database "${input.schema.database}":\n\n${ddl}`,
          cacheable: true,
        },
      ],
      messages: [
        ...this.renderHistory(input.history ?? []),
        { role: 'user', content: input.question },
      ],
      jsonSchema: SQL_OUTPUT_SCHEMA,
    };
  }

  /**
   * Replays earlier turns as a user/assistant exchange. The assistant side is
   * reduced to the query it produced — the full JSON would spend tokens
   * restating a contract the output schema already enforces.
   */
  private renderHistory(
    history: ConversationTurn[],
  ): LlmCompletionRequest['messages'] {
    return history.flatMap((turn) => [
      { role: 'user' as const, content: turn.question },
      {
        role: 'assistant' as const,
        content: turn.generation.answerable
          ? turn.generation.sql
          : `Not answerable from this schema: ${turn.generation.explanation}`,
      },
    ]);
  }
}
