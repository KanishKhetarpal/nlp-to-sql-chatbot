import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SchemaCacheService } from './schema-cache.service';
import { SchemaIntrospectionService } from './schema-introspection.service';
import { SchemaService } from './schema.service';
import { DatabaseSchema } from './schema.types';

const snapshot = (marker: string): DatabaseSchema => ({
  database: 'test_db',
  schemas: ['public'],
  tables: [],
  introspectedAt: marker,
});

describe('SchemaService', () => {
  let service: SchemaService;
  let cache: SchemaCacheService;
  let introspect: jest.Mock;

  const build = async (ttlSeconds: number): Promise<TestingModule> => {
    introspect = jest.fn().mockResolvedValue(snapshot('first'));

    return Test.createTestingModule({
      providers: [
        SchemaService,
        SchemaCacheService,
        { provide: SchemaIntrospectionService, useValue: { introspect } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue({
              schemas: ['public'],
              cacheTtlSeconds: ttlSeconds,
            }),
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
