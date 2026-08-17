import { SchemaSerializerService } from '../schema/schema-serializer.service';
import {
  PromptBuilderService,
  SQL_OUTPUT_SCHEMA,
} from './prompt-builder.service';
import { DatabaseSchema, TableMetadata } from '../schema/schema.types';
import { ConversationTurn } from './nl-to-sql.types';

const customers: TableMetadata = {
  schema: 'public',
  name: 'customers',
  kind: 'table',
  comment: 'People who have registered an account.',
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
    {
      name: 'country',
      position: 2,
      dataType: 'character varying(100)',
      isNullable: true,
      defaultValue: null,
      comment: 'ISO country name, not code.',
      isPrimaryKey: false,
    },
  ],
};

const schema: DatabaseSchema = {
  database: 'nlp_to_sql',
  schemas: ['public'],
  tables: [customers],
  introspectedAt: '2026-01-01T00:00:00.000Z',
};

const turn = (
  question: string,
  overrides: Partial<ConversationTurn['generation']> = {},
): ConversationTurn => ({
  question,
  askedAt: '2026-01-01T00:00:00.000Z',
  generation: {
    answerable: true,
    sql: 'SELECT count(*) FROM customers;',
    explanation: 'Counts every customer row.',
    tables: ['customers'],
    ...overrides,
  },
});

describe('PromptBuilderService', () => {
  const service = new PromptBuilderService(new SchemaSerializerService());

  const build = (
    question = 'How many customers are there?',
    history?: ConversationTurn[],
  ) => service.build({ question, schema, history });

  describe('system prompt', () => {
    it('states the SELECT-only rule the validator will enforce', () => {
      const instructions = build().system[0].text;

      expect(instructions).toContain('SELECT');
      expect(instructions.toLowerCase()).toContain('one statement');
    });

    it('tells the model to refuse rather than guess at missing columns', () => {
      const instructions = build().system[0].text;

      expect(instructions).toContain('answerable to false');
    });

    it('includes the serialized schema and names the database', () => {
      const schemaBlock = build().system[1].text;

      expect(schemaBlock).toContain('nlp_to_sql');
      expect(schemaBlock).toContain('CREATE TABLE customers (');
      expect(schemaBlock).toContain('id integer NOT NULL');
    });

    it('carries the column comments through to the prompt', () => {
      const schemaBlock = build().system[1].text;

      expect(schemaBlock).toContain('-- ISO country name, not code.');
    });

    it('marks the schema block as the cache breakpoint, not the instructions', () => {
      const { system } = build();

      expect(system[0].cacheable).toBeUndefined();
      expect(system[1].cacheable).toBe(true);
    });

    it('keeps the fixed instructions ahead of the schema', () => {
      // Caching is a prefix match, so the least volatile block must come first.
      const { system } = build();

      expect(system).toHaveLength(2);
      expect(system[0].text).toContain('You translate');
    });
  });

  describe('messages', () => {
    it('sends the question as the only message when there is no history', () => {
      expect(build('How many customers are there?').messages).toEqual([
        { role: 'user', content: 'How many customers are there?' },
      ]);
    });

    it('replays earlier turns before the new question', () => {
      const { messages } = build('And how many are in the UK?', [
        turn('How many customers are there?'),
      ]);

      expect(messages).toEqual([
        { role: 'user', content: 'How many customers are there?' },
        { role: 'assistant', content: 'SELECT count(*) FROM customers;' },
        { role: 'user', content: 'And how many are in the UK?' },
      ]);
    });

    it('replays an unanswerable turn as a refusal, not as empty SQL', () => {
      const { messages } = build('What about revenue?', [
        turn('What is our churn rate?', {
          answerable: false,
          sql: '',
          explanation: 'The schema has no subscription or cancellation data.',
        }),
      ]);

      expect(messages[1]).toEqual({
        role: 'assistant',
        content:
          'Not answerable from this schema: The schema has no subscription or cancellation data.',
      });
    });

    it('preserves the order of a multi-turn conversation', () => {
      const { messages } = build('third', [turn('first'), turn('second')]);

      expect(messages.map((m) => m.content)).toEqual([
        'first',
        'SELECT count(*) FROM customers;',
        'second',
        'SELECT count(*) FROM customers;',
        'third',
      ]);
    });

    it('always ends on the user turn', () => {
      const { messages } = build('latest', [turn('earlier')]);

      expect(messages[messages.length - 1]).toEqual({
        role: 'user',
        content: 'latest',
      });
    });
  });

  describe('output contract', () => {
    it('requests the structured output schema', () => {
      expect(build().jsonSchema).toBe(SQL_OUTPUT_SCHEMA);
    });

    it('requires every field the generator reads', () => {
      expect(SQL_OUTPUT_SCHEMA.required).toEqual([
        'answerable',
        'sql',
        'explanation',
        'tables',
      ]);
    });

    it('forbids extra properties, which structured outputs requires', () => {
      expect(SQL_OUTPUT_SCHEMA.additionalProperties).toBe(false);
    });
  });
});
