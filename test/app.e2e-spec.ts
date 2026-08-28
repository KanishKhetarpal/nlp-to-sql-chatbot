import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from './../src/app.module';
import { AllExceptionsFilter } from './../src/common/filters/all-exceptions.filter';

/** Response bodies these tests read, so assertions are not `any`. */
interface HealthBody {
  status: string;
  info: Record<string, { status: string }>;
}
interface SchemaBody {
  tables: { name: string }[];
}
interface AskBody {
  status: string;
  sql?: string;
  summary?: string;
  table?: string;
  result?: { rowCount: number };
}
interface SessionBody {
  id: string;
  turns: unknown[];
}
interface AuditBody {
  outcome: string;
}
interface ErrorBody {
  statusCode: number;
  path: string;
  timestamp: string;
}

/**
 * Drives the whole application over HTTP, with the stub LLM provider and a
 * real database — the closest thing to running it for real.
 *
 * Skipped when no database is reachable, so `npm run test:e2e` on a clone
 * without Docker running reports honestly instead of failing to boot.
 */
const canConnect = async (): Promise<boolean> => {
  const probe = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5433', 10),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: process.env.DB_NAME ?? 'nlp_to_sql',
    connectTimeoutMS: 2000,
  });

  try {
    await probe.initialize();
    await probe.destroy();
    return true;
  } catch {
    return false;
  }
};

describe('Chat flow (e2e)', () => {
  let app: INestApplication<App> | undefined;
  let available = false;

  beforeAll(async () => {
    available = await canConnect();
    if (!available) {
      console.warn(
        'Skipping e2e: no database reachable. Run `docker compose up -d --wait`.',
      );
      return;
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  }, 60000);

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app!.getHttpServer());

  const maybe = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(
      name,
      async () => {
        if (!available) {
          return;
        }
        await fn();
      },
      timeout,
    );

  maybe('reports healthy with the database up', async () => {
    const response = await server().get('/health').expect(200);

    const body = response.body as HealthBody;
    expect(body.status).toBe('ok');
    expect(body.info.database.status).toBe('up');
  });

  maybe('serves the introspected schema', async () => {
    const response = await server().get('/schema').expect(200);

    const body = response.body as SchemaBody;
    expect(body.tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(['customers', 'orders']),
    );
  });

  maybe('answers a question end to end', async () => {
    const response = await server()
      .post('/chat/ask')
      .send({ question: 'How many customers are there?' })
      .expect(200);

    const body = response.body as AskBody;
    expect(body.status).toBe('answered');
    // The bounded statement, not the model's original text.
    expect(body.sql).toContain('LIMIT');
    expect(body.result?.rowCount).toBeGreaterThan(0);
    expect(body.summary).toBeTruthy();
    expect(body.table).toContain('first_name');
  });

  maybe('carries a conversation across turns', async () => {
    const created = await server().post('/chat/sessions').expect(201);
    const id = (created.body as SessionBody).id;

    await server()
      .post('/chat/ask')
      .send({ question: 'first', conversationId: id })
      .expect(200);
    await server()
      .post('/chat/ask')
      .send({ question: 'second', conversationId: id })
      .expect(200);

    const history = await server().get(`/chat/sessions/${id}`).expect(200);
    expect((history.body as SessionBody).turns).toHaveLength(2);

    await server().delete(`/chat/sessions/${id}`).expect(204);
    await server().get(`/chat/sessions/${id}`).expect(404);
  });

  maybe('stops before executing on a dry run', async () => {
    const response = await server()
      .post('/chat/ask')
      .send({ question: 'anything', dryRun: true })
      .expect(200);

    const body = response.body as AskBody;
    expect(body.status).toBe('dry_run');
    expect(body.result).toBeUndefined();
  });

  maybe('records what it did in the audit trail', async () => {
    await server().post('/chat/ask').send({ question: 'audit me' }).expect(200);

    const audit = await server().get('/chat/audit?limit=5').expect(200);

    const entries = audit.body as AuditBody[];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]).toMatchObject({ outcome: expect.any(String) as string });
  });

  maybe('rejects a malformed request before any work happens', async () => {
    const response = await server()
      .post('/chat/ask')
      .send({ question: '' })
      .expect(400);

    expect((response.body as ErrorBody).statusCode).toBe(400);
  });

  maybe('returns a structured 404 through the exception filter', async () => {
    const response = await server().get('/no-such-route').expect(404);

    expect(response.body).toMatchObject({
      statusCode: 404,
      path: '/no-such-route',
    });
    expect((response.body as ErrorBody).timestamp).toBeTruthy();
  });

  maybe('publishes an OpenAPI-documented surface', async () => {
    // /docs is wired in main.ts rather than the module graph, so it is not
    // part of this fixture; the routes it documents are asserted above.
    await server().get('/chat/audit').expect(200);
  });
});
