import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ChatController } from './chat.controller';
import { AskService } from '../nl-to-sql/ask.service';
import { ConversationService } from '../nl-to-sql/conversation.service';
import { QueryAuditService } from '../execution/query-audit.service';
import { ApiKeyGuard } from '../common/guards/api-key.guard';

/** Response bodies these tests read, so assertions are not `any`. */
interface AskBody {
  status: string;
  summary?: string;
}
interface SessionBody {
  id: string;
  turns: unknown[];
}

/**
 * Drives the controller over real HTTP with the pipeline mocked out, so these
 * cover the HTTP contract — routes, status codes, request validation, auth and
 * rate limiting — without needing a database or a model.
 */
describe('ChatController (HTTP)', () => {
  let app: INestApplication<App>;
  let ask: jest.Mock;
  let conversations: {
    create: jest.Mock;
    get: jest.Mock;
    delete: jest.Mock;
    resolve: jest.Mock;
  };

  const answered = {
    status: 'answered',
    conversationId: '3f1c2b7e-6a4d-4f0e-9d1a-2b3c4d5e6f70',
    question: 'How many customers?',
    generation: {
      answerable: true,
      sql: 'SELECT count(*) FROM customers',
      explanation: 'Counts rows.',
      tables: ['customers'],
    },
    sql: 'SELECT count(*) FROM "customers" LIMIT 500',
    result: {
      columns: ['count'],
      rows: [{ count: 5 }],
      rowCount: 1,
      truncated: false,
      durationMs: 3,
    },
    summary: 'count: 5',
    table: 'count\n-----\n5',
    model: 'claude-opus-5',
  };

  const build = async (apiKeys: string[] = [], rateLimit = 1000) => {
    ask = jest.fn().mockResolvedValue(answered);
    conversations = {
      create: jest.fn().mockReturnValue({
        id: answered.conversationId,
        createdAt: 'now',
        lastActiveAt: 'now',
        turns: [],
      }),
      get: jest.fn().mockReturnValue({
        id: answered.conversationId,
        createdAt: 'now',
        lastActiveAt: 'now',
        turns: [],
      }),
      delete: jest.fn(),
      resolve: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: rateLimit }])],
      controllers: [ChatController],
      providers: [
        { provide: AskService, useValue: { ask } },
        { provide: ConversationService, useValue: conversations },
        {
          provide: QueryAuditService,
          useValue: { recent: jest.fn().mockReturnValue([{ at: 'now' }]) },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue({
              keys: apiKeys,
              rateLimit,
              rateWindowSeconds: 60,
            }),
          },
        },
        Reflector,
        { provide: APP_GUARD, useClass: ApiKeyGuard },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();

    const created: INestApplication<App> = moduleRef.createNestApplication();
    created.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await created.init();
    return created;
  };

  afterEach(async () => {
    await app?.close();
  });

  describe('POST /chat/ask', () => {
    beforeEach(async () => {
      app = await build();
    });

    it('answers a question', async () => {
      const response = await request(app.getHttpServer())
        .post('/chat/ask')
        .send({ question: 'How many customers?' })
        .expect(200);

      const body = response.body as AskBody;
      expect(body.status).toBe('answered');
      expect(body.summary).toBe('count: 5');
    });

    it('passes the conversation id through so follow-ups continue', async () => {
      await request(app.getHttpServer())
        .post('/chat/ask')
        .send({
          question: 'And in the UK?',
          conversationId: answered.conversationId,
        })
        .expect(200);

      expect(ask).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: answered.conversationId }),
      );
    });

    it('forwards a dry run', async () => {
      await request(app.getHttpServer())
        .post('/chat/ask')
        .send({ question: 'anything', dryRun: true })
        .expect(200);

      expect(ask).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true }),
      );
    });

    it('answers 200 for a refused query, since that is an answer', async () => {
      ask.mockResolvedValue({ ...answered, status: 'rejected' });

      const response = await request(app.getHttpServer())
        .post('/chat/ask')
        .send({ question: 'delete everything' })
        .expect(200);

      expect((response.body as AskBody).status).toBe('rejected');
    });

    describe('request validation', () => {
      it('rejects a missing question', async () => {
        await request(app.getHttpServer())
          .post('/chat/ask')
          .send({})
          .expect(400);
      });

      it('rejects an empty question', async () => {
        await request(app.getHttpServer())
          .post('/chat/ask')
          .send({ question: '' })
          .expect(400);
      });

      it('rejects a question beyond the length limit', async () => {
        await request(app.getHttpServer())
          .post('/chat/ask')
          .send({ question: 'x'.repeat(1001) })
          .expect(400);
      });

      it('rejects a conversation id that is not a UUID', async () => {
        await request(app.getHttpServer())
          .post('/chat/ask')
          .send({ question: 'hi', conversationId: 'not-a-uuid' })
          .expect(400);
      });

      it('rejects an unknown field rather than ignoring it', async () => {
        // A typo in a field name should be reported, not silently dropped.
        await request(app.getHttpServer())
          .post('/chat/ask')
          .send({ question: 'hi', dry_run: true })
          .expect(400);
      });

      it('never reaches the pipeline when validation fails', async () => {
        await request(app.getHttpServer()).post('/chat/ask').send({});

        expect(ask).not.toHaveBeenCalled();
      });
    });
  });

  describe('sessions', () => {
    beforeEach(async () => {
      app = await build();
    });

    it('creates a conversation', async () => {
      const response = await request(app.getHttpServer())
        .post('/chat/sessions')
        .expect(201);

      expect((response.body as SessionBody).id).toBe(answered.conversationId);
    });

    it('returns the history', async () => {
      const response = await request(app.getHttpServer())
        .get(`/chat/sessions/${answered.conversationId}`)
        .expect(200);

      expect(response.body).toHaveProperty('turns');
    });

    it('rejects a malformed id', async () => {
      await request(app.getHttpServer()).get('/chat/sessions/nope').expect(400);
    });

    it('deletes a conversation', async () => {
      await request(app.getHttpServer())
        .delete(`/chat/sessions/${answered.conversationId}`)
        .expect(204);

      expect(conversations.delete).toHaveBeenCalledWith(
        answered.conversationId,
      );
    });
  });

  describe('audit', () => {
    it('returns recent entries', async () => {
      app = await build();

      const response = await request(app.getHttpServer())
        .get('/chat/audit')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });
  });

  describe('API key auth', () => {
    it('leaves routes open when no keys are configured', async () => {
      app = await build([]);

      await request(app.getHttpServer())
        .post('/chat/ask')
        .send({ question: 'hi' })
        .expect(200);
    });

    it('refuses a request with no key once keys are configured', async () => {
      app = await build(['secret-key']);

      await request(app.getHttpServer())
        .post('/chat/ask')
        .send({ question: 'hi' })
        .expect(401);
    });

    it('refuses a wrong key', async () => {
      app = await build(['secret-key']);

      await request(app.getHttpServer())
        .post('/chat/ask')
        .set('x-api-key', 'wrong-key')
        .send({ question: 'hi' })
        .expect(401);
    });

    it('accepts a configured key', async () => {
      app = await build(['secret-key']);

      await request(app.getHttpServer())
        .post('/chat/ask')
        .set('x-api-key', 'secret-key')
        .send({ question: 'hi' })
        .expect(200);
    });

    it('accepts any of several configured keys', async () => {
      app = await build(['first-key', 'second-key']);

      await request(app.getHttpServer())
        .post('/chat/ask')
        .set('x-api-key', 'second-key')
        .send({ question: 'hi' })
        .expect(200);
    });

    it('rejects a key that only shares a prefix', async () => {
      app = await build(['secret-key']);

      await request(app.getHttpServer())
        .post('/chat/ask')
        .set('x-api-key', 'secret')
        .send({ question: 'hi' })
        .expect(401);
    });
  });

  describe('rate limiting', () => {
    it('refuses once the window budget is spent', async () => {
      app = await build([], 2);

      await request(app.getHttpServer())
        .post('/chat/ask')
        .send({ question: 'one' })
        .expect(200);
      await request(app.getHttpServer())
        .post('/chat/ask')
        .send({ question: 'two' })
        .expect(200);
      await request(app.getHttpServer())
        .post('/chat/ask')
        .send({ question: 'three' })
        .expect(429);
    });
  });
});
