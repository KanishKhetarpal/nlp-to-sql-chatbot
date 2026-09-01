import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SchemaCacheService } from './schema-cache.service';
import { SchemaIntrospectionService } from './schema-introspection.service';
import { SchemaSerializerService } from './schema-serializer.service';
import { SchemaService } from './schema.service';
import { DatabaseSchema } from './schema.types';

const table = (name: string): DatabaseSchema['tables'][number] => ({
  schema: 'public',
  name,
  kind: 'table',
  comment: null,
  columns: [],
  primaryKey: [],
  foreignKeys: [],
  uniqueConstraints: [],
});

const snapshot = (marker: string, names: string[] = []): DatabaseSchema => ({
  database: 'test_db',
  schemas: ['public'],
  tables: names.map(table),
  introspectedAt: marker,
});

describe('SchemaService', () => {
  let service: SchemaService;
  let cache: SchemaCacheService;
  let introspect: jest.Mock;

  const build = async (
    ttlSeconds: number,
    safety: { allowedTables: string[]; deniedTables: string[] } = {
      allowedTables: [],
      deniedTables: [],
    },
    tables: string[] = [],
  ): Promise<TestingModule> => {
    introspect = jest.fn().mockResolvedValue(snapshot('first', tables));

    return Test.createTestingModule({
      providers: [
        SchemaService,
        SchemaCacheService,
        { provide: SchemaIntrospectionService, useValue: { introspect } },
        {
          provide: ConfigService,
          useValue: {
            // Key-aware: the service asks for two different sections, and a
            // mock that answers both with the same object would let a wrong
            // key pass unnoticed.
            get: jest.fn((key: string) =>
              key === 'sqlSafety'
                ? safety
                : { schemas: ['public'], cacheTtlSeconds: ttlSeconds },
            ),
          },
        },
      ],
    }).compile();
  };

  describe('with caching enabled', () => {
    beforeEach(async () => {
      const module = await build(300);
      service = module.get(SchemaService);
      cache = module.get(SchemaCacheService);
    });

    it('introspects on the first call', async () => {
      await expect(service.getSchema()).resolves.toMatchObject({
        database: 'test_db',
      });
      expect(introspect).toHaveBeenCalledTimes(1);
    });

    it('serves later calls from cache without touching the database', async () => {
      await service.getSchema();
      await service.getSchema();
      await service.getSchema();

      expect(introspect).toHaveBeenCalledTimes(1);
    });

    it('collapses concurrent cold-cache calls into one introspection', async () => {
      const results = await Promise.all([
        service.getSchema(),
        service.getSchema(),
        service.getSchema(),
      ]);

      expect(introspect).toHaveBeenCalledTimes(1);
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);
    });

    it('re-reads the catalogs when asked to refresh', async () => {
      await service.getSchema();
      introspect.mockResolvedValue(snapshot('second'));

      const refreshed = await service.refresh();

      expect(introspect).toHaveBeenCalledTimes(2);
      expect(refreshed.introspectedAt).toBe('second');
    });

    it('caches the refreshed snapshot in place of the old one', async () => {
      await service.getSchema();
      introspect.mockResolvedValue(snapshot('second'));
      await service.refresh();

      const afterRefresh = await service.getSchema();

      expect(introspect).toHaveBeenCalledTimes(2);
      expect(afterRefresh.introspectedAt).toBe('second');
    });

    it('introspects again once the entry has expired', async () => {
      await service.getSchema();
      cache.invalidate();

      await service.getSchema();

      expect(introspect).toHaveBeenCalledTimes(2);
    });

    it('reports cache status', async () => {
      expect(service.cacheStatus()).toMatchObject({
        enabled: true,
        cached: false,
        ttlSeconds: 300,
        expiresAt: null,
      });

      await service.getSchema();

      const status = service.cacheStatus();
      expect(status.cached).toBe(true);
      expect(Date.parse(status.expiresAt!)).toBeGreaterThan(Date.now() - 1000);
    });

    it('does not poison the cache when introspection fails', async () => {
      introspect.mockRejectedValueOnce(new Error('connection refused'));

      await expect(service.getSchema()).rejects.toThrow('connection refused');

      // The failure must not leave an in-flight promise behind, or every
      // later caller would be handed the same rejection forever.
      await expect(service.getSchema()).resolves.toMatchObject({
        database: 'test_db',
      });
      expect(introspect).toHaveBeenCalledTimes(2);
    });
  });

  describe('with a deny list configured', () => {
    it('does not serve a denied table to any caller', async () => {
      // Everything downstream — the prompt, GET /schema — reads through this
      // service, so hiding it here hides it everywhere.
      const module = await build(
        300,
        { allowedTables: [], deniedTables: ['salaries'] },
        ['customers', 'salaries', 'orders'],
      );

      const schema = await module.get(SchemaService).getSchema();

      expect(schema.tables.map((row) => row.name)).toEqual([
        'customers',
        'orders',
      ]);
    });

    it('keeps the full snapshot in cache, so the rules stay changeable', async () => {
      const module = await build(
        300,
        { allowedTables: [], deniedTables: ['salaries'] },
        ['customers', 'salaries'],
      );
      const service = module.get(SchemaService);

      await service.getSchema();
      await service.getSchema();

      // Narrowing must not be applied to the cached object itself: a filter
      // written in place would make the hiding permanent and irreversible.
      expect(module.get(SchemaCacheService).get()?.tables).toHaveLength(2);
    });

    it('keeps the denied table out of the prompt DDL', async () => {
      // The defect this closes: the deny list was consulted only at safety
      // review, so a denied table's columns and comments were serialized
      // into every prompt and sent to the model provider regardless.
      const module = await build(
        300,
        { allowedTables: [], deniedTables: ['salaries'] },
        ['customers', 'salaries'],
      );

      const schema = await module.get(SchemaService).getSchema();
      const ddl = new SchemaSerializerService().serialize(schema);

      expect(ddl).toContain('CREATE TABLE customers');
      expect(ddl).not.toContain('salaries');
    });

    it('narrows a refreshed snapshot too', async () => {
      const module = await build(
        300,
        { allowedTables: [], deniedTables: ['salaries'] },
        ['customers', 'salaries'],
      );
      const service = module.get(SchemaService);

      const refreshed = await service.refresh();

      expect(refreshed.tables.map((row) => row.name)).toEqual(['customers']);
    });
  });

  describe('with an allow list configured', () => {
    it('serves only the tables on it', async () => {
      const module = await build(
        300,
        { allowedTables: ['customers'], deniedTables: [] },
        ['customers', 'salaries', 'orders'],
      );

      const schema = await module.get(SchemaService).getSchema();

      expect(schema.tables.map((row) => row.name)).toEqual(['customers']);
    });
  });

  describe('with caching disabled', () => {
    beforeEach(async () => {
      const module = await build(0);
      service = module.get(SchemaService);
    });

    it('introspects on every call', async () => {
      await service.getSchema();
      await service.getSchema();

      expect(introspect).toHaveBeenCalledTimes(2);
      expect(service.cacheStatus()).toMatchObject({
        enabled: false,
        cached: false,
      });
    });
  });
});
