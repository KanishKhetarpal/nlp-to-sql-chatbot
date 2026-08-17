import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SchemaService } from '../schema/schema.service';
import { SchemaSerializerService } from '../schema/schema-serializer.service';
import { LlmClient, LlmRefusalError } from '../llm/llm.types';
import { ConversationService } from './conversation.service';
import { PromptBuilderService } from './prompt-builder.service';
import {
  MalformedGenerationError,
  SqlGenerationService,
} from './sql-generation.service';
import { DatabaseSchema } from '../schema/schema.types';

const schema: DatabaseSchema = {
  database: 'nlp_to_sql',
  schemas: ['public'],
  tables: [
    {
      schema: 'public',
      name: 'customers',
      kind: 'table',
      comment: null,
      primaryKey: ['id'],
      uniqueConstraints: [],
      foreignKeys: [],
      columns: [
        {
          name: 'id',
          position: 1,
          dataType: 'integer',
          isNullable: false,
          defaultValue: null,
          comment: null,
          isPrimaryKey: true,
        },
      ],
    },
  ],
  introspectedAt: '2026-01-01T00:00:00.000Z',
};

const answer = {
  answerable: true,
  sql: 'SELECT count(*) FROM customers;',
  explanation: 'Counts customer rows.',
  tables: ['customers'],
};

/** The parts of the prompt these tests assert on. */
interface SentPrompt {
  system: { text: string }[];
  messages: { role: string; content: string }[];
}

describe('SqlGenerationService', () => {
  let service: SqlGenerationService;
  let conversations: ConversationService;
  let complete: jest.Mock;

  /** Typed view of a prompt passed to the LLM, so assertions aren't `any`. */
  const sentPrompt = (index = 0): SentPrompt =>
    (complete.mock.calls as unknown as [SentPrompt][])[index][0];

  const respond = (text: string) =>
    complete.mockResolvedValue({
      text,
      model: 'claude-opus-5',
      stopReason: 'end_turn',
      usage: {
        inputTokens: 900,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });

  beforeEach(async () => {
    complete = jest.fn();
    respond(JSON.stringify(answer));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SqlGenerationService,
        PromptBuilderService,
        SchemaSerializerService,
        ConversationService,
        {
          provide: SchemaService,
          useValue: { getSchema: jest.fn().mockResolvedValue(schema) },
        },
        {
          provide: LlmClient,
          useValue: {
            complete,
            describe: () => ({ provider: 'test', model: 'test' }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue({
              ttlSeconds: 3600,
              maxTurns: 20,
              maxSessions: 100,
            }),
          },
        },
      ],
    }).compile();

    service = module.get(SqlGenerationService);
    conversations = module.get(ConversationService);
  });

  it('returns the generated query with the model and usage that produced it', async () => {
    const result = await service.generate({ question: 'How many customers?' });

    expect(result.generation).toEqual(answer);
    expect(result.model).toBe('claude-opus-5');
    expect(result.usage.outputTokens).toBe(40);
  });

  it('starts a conversation and records the turn', async () => {
    const result = await service.generate({ question: 'How many customers?' });

    const conversation = conversations.get(result.conversationId);
    expect(conversation.turns).toHaveLength(1);
    expect(conversation.turns[0].question).toBe('How many customers?');
    expect(conversation.turns[0].generation).toEqual(answer);
  });

  it('continues an existing conversation and feeds prior turns to the model', async () => {
    const first = await service.generate({ question: 'How many customers?' });
    await service.generate({
      question: 'And how many in the UK?',
      conversationId: first.conversationId,
    });

    expect(conversations.get(first.conversationId).turns).toHaveLength(2);

    // The second call must carry the first exchange, or a follow-up like
    // "and how many in the UK?" has nothing to resolve against.
    expect(sentPrompt(1).messages).toEqual([
      { role: 'user', content: 'How many customers?' },
      { role: 'assistant', content: 'SELECT count(*) FROM customers;' },
      { role: 'user', content: 'And how many in the UK?' },
    ]);
  });

  it('sends the serialized schema as prompt context', async () => {
    await service.generate({ question: 'How many customers?' });

    expect(sentPrompt().system[1].text).toContain('CREATE TABLE customers (');
  });

  it('passes an unanswerable verdict through with no SQL', async () => {
    respond(
      JSON.stringify({
        answerable: false,
        sql: '',
        explanation: 'No revenue data in this schema.',
        tables: [],
      }),
    );

    const result = await service.generate({ question: 'What is our revenue?' });

    expect(result.generation.answerable).toBe(false);
    expect(result.generation.sql).toBe('');
    expect(result.generation.explanation).toBe(
      'No revenue data in this schema.',
    );
  });

  it('discards SQL that accompanies an unanswerable verdict', async () => {
    respond(JSON.stringify({ ...answer, answerable: false, sql: 'SELECT 1;' }));

    const result = await service.generate({ question: 'anything' });

    expect(result.generation.sql).toBe('');
  });

  it('tolerates a fenced JSON block', async () => {
    respond('```json\n' + JSON.stringify(answer) + '\n```');

    const result = await service.generate({ question: 'How many customers?' });

    expect(result.generation.sql).toBe('SELECT count(*) FROM customers;');
  });

  it('trims surrounding whitespace from the SQL', async () => {
    respond(JSON.stringify({ ...answer, sql: '  SELECT 1;  ' }));

    const result = await service.generate({ question: 'q' });

    expect(result.generation.sql).toBe('SELECT 1;');
  });

  it('drops non-string entries from the tables list', async () => {
    respond(JSON.stringify({ ...answer, tables: ['customers', 7, null] }));

    const result = await service.generate({ question: 'q' });

    expect(result.generation.tables).toEqual(['customers']);
  });

  describe('malformed provider output', () => {
    it.each([
      ['not JSON at all', 'Sure! Here is your query.'],
      ['JSON that is not an object', '"just a string"'],
      ['a missing answerable field', JSON.stringify({ sql: 'SELECT 1;' })],
      ['a missing sql field', JSON.stringify({ answerable: true })],
      [
        'answerable with empty SQL',
        JSON.stringify({ answerable: true, sql: '   ' }),
      ],
    ])('rejects %s', async (_label, text) => {
      respond(text);

      await expect(service.generate({ question: 'q' })).rejects.toBeInstanceOf(
        MalformedGenerationError,
      );
    });

    it('keeps the raw response on the error for debugging', async () => {
      respond('nonsense');

      await expect(service.generate({ question: 'q' })).rejects.toMatchObject({
        raw: 'nonsense',
      });
    });

    it('does not record a turn when the response is unusable', async () => {
      const first = await service.generate({ question: 'good question' });
      respond('nonsense');

      await expect(
        service.generate({
          question: 'bad response',
          conversationId: first.conversationId,
        }),
      ).rejects.toBeInstanceOf(MalformedGenerationError);

      expect(conversations.get(first.conversationId).turns).toHaveLength(1);
    });
  });

  it('lets a provider refusal propagate rather than masking it', async () => {
    complete.mockRejectedValue(new LlmRefusalError('cyber', 'declined'));

    await expect(service.generate({ question: 'q' })).rejects.toBeInstanceOf(
      LlmRefusalError,
    );
  });
});
