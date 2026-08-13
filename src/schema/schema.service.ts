import { Injectable, Logger } from '@nestjs/common';
import { SchemaCacheService, CacheStatus } from './schema-cache.service';
import { SchemaIntrospectionService } from './schema-introspection.service';
import { DatabaseSchema } from './schema.types';

/**
 * The way the rest of the application asks for database metadata.
 *
 * Sits in front of the introspection service and the cache so no caller has to
 * decide between them, and collapses concurrent misses into a single
 * introspection: on a cold cache a burst of requests would otherwise each fire
 * their own set of catalog queries.
 */
@Injectable()
export class SchemaService {
  private readonly logger = new Logger(SchemaService.name);

  /** Shared by every caller that arrives while an introspection is running. */
  private inFlight: Promise<DatabaseSchema> | null = null;

  constructor(
    private readonly introspection: SchemaIntrospectionService,
    private readonly cache: SchemaCacheService,
  ) {}

  async getSchema(options: { refresh?: boolean } = {}): Promise<DatabaseSchema> {
    if (!options.refresh) {
      const cached = this.cache.get();
      if (cached) {
        return cached;
      }
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.introspection
      .introspect()
      .then((snapshot) => {
        this.cache.set(snapshot);
        return snapshot;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  /** Discards the cached snapshot and reads the catalogs again. */
  async refresh(): Promise<DatabaseSchema> {
    this.logger.log('Refreshing schema snapshot');
    this.cache.invalidate();
    return this.getSchema({ refresh: true });
  }

  cacheStatus(): CacheStatus {
    return this.cache.status();
  }
}
