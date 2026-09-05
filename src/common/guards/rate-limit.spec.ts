import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import {
  HealthCheckService,
  TypeOrmHealthIndicator,
  HealthCheckResult,
} from '@nestjs/terminus';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ChatController } from '../../chat/chat.controller';
import { HealthController } from '../../health/health.controller';
import { AskService } from '../../nl-to-sql/ask.service';
import { ConversationService } from '../../nl-to-sql/conversation.service';
import { QueryAuditService } from '../../execution/query-audit.service';
import { ApiKeyGuard } from './api-key.guard';
import { ClientThrottlerGuard } from './client-throttler.guard';

const KEY_A = 'key-alpha-0000000000';
const KEY_B = 'key-beta-00000000000';

const healthy: HealthCheckResult = {
  status: 'ok',
  info: { database: { status: 'up' } },
  error: {},
  details: { database: { status: 'up' } },
};

/**
 * Rate limiting, driven over HTTP, because the thing being checked is which
 * requests share a budget — and that is decided by the guard stack rather
 * than by any one class.
 */
describe('rate limiting', () => {
  let app: INestApplication<App>;

  const build = async (
    apiKeys: string[],
    limit: number,
  ): Promise<INestApplication<App>> => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit }])],
      controllers: [ChatController, HealthController],
      providers: [
        {
          provide: AskService,
          useValue: { ask: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: ConversationService,
          useValue: { create: jest.fn(), get: jest.fn(), delete: jest.fn() },
        },
        {
          provide: QueryAuditService,
          useValue: { recent: jest.fn().mockReturnValue([]) },
        },
        {
          provide: HealthCheckService,
          useValue: { check: jest.fn().mockResolvedValue(healthy) },
        },
        {
          provide: TypeOrmHealthIndicator,
          useValue: { pingCheck: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue({ keys: apiKeys }) },
        },
        { provide: APP_GUARD, useClass: ApiKeyGuard },
        { provide: APP_GUARD, useClass: ClientThrottlerGuard },
      ],
    }).compile();

    const created: INestApplication<App> = moduleRef.createNestApplication();
    await created.init();
    return created;
  };

  /** One audit read, optionally as a given caller. */
  const call = (key?: string) => {
    const pending = request(app.getHttpServer()).get('/chat/audit');
    return key ? pending.set('x-api-key', key) : pending;
  };

  afterEach(async () => {
    await app?.close();
  });

  describe('with API keys configured', () => {
    it('gives each key its own budget', async () => {
      // The defect this closes: the stock guard tracks req.ip, so two keys
      // sharing an egress address — or arriving through the same proxy —
      // shared one allowance, and either could spend all of it.
      app = await build([KEY_A, KEY_B], 2);

      await call(KEY_A).expect(200);
      await call(KEY_A).expect(200);

      await call(KEY_B).expect(200);
    });

    it('still stops one key going over its own budget', async () => {
      app = await build([KEY_A, KEY_B], 2);

      await call(KEY_A).expect(200);
      await call(KEY_A).expect(200);

      await call(KEY_A).expect(429);
    });

    it('does not count a request it rejected as unauthenticated', async () => {
      // Authentication runs first, so a wrong key cannot spend the budget of
      // whoever is on the same address.
      app = await build([KEY_A], 2);

      await call('wrong-key').expect(401);
      await call('wrong-key').expect(401);
      await call('wrong-key').expect(401);

      await call(KEY_A).expect(200);
    });
  });

  describe('with no API keys configured', () => {
    it('falls back to the address, because something has to bound it', async () => {
      app = await build([], 2);

      await call().expect(200);
      await call().expect(200);

      await call().expect(429);
    });
  });

  describe('the health endpoint', () => {
    it('is never rate limited', async () => {
      // A throttled probe answers 429, the orchestrator reads that as
      // unhealthy, and a service that was merely busy gets restarted.
      app = await build([], 1);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(app.getHttpServer()).get('/health').expect(200);
      }
    });

    it('does not spend the budget of traffic sharing its address', async () => {
      app = await build([], 2);

      await request(app.getHttpServer()).get('/health').expect(200);
      await request(app.getHttpServer()).get('/health').expect(200);
      await request(app.getHttpServer()).get('/health').expect(200);

      await call().expect(200);
      await call().expect(200);
    });
  });
});
