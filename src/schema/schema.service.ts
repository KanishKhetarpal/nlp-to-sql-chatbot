import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SqlSafetyConfig } from '../config/configuration';
import { SchemaCacheService, CacheStatus } from './schema-cache.service';
import { SchemaIntrospectionService } from './schema-introspection.service';
import { applyVisibility, VisibilityRules } from './schema-visibility';
import { DatabaseSchema } from './schema.types';

/**
 * The way the rest of the application asks for database metadata.
 *
 * Sits in front of the introspection service and the cache so no caller has to
 * decide between them, and collapses concurrent misses into a single
 * introspection: on a cold cache a burst of requests would otherwise each fire
 * their own set of catalog queries.
 *
 * It is also where the allow and deny lists are applied, so every consumer —
 * the prompt builder, the schema endpoint — sees the same narrowed view
 * without having to remember to narrow it.
 */
@Injectable()
export class SchemaService {
  private readonly logger = new Logger(SchemaService.name);

  /** Shared by every caller that arrives while an introspection is running. */
  private inFlight: Promise<DatabaseSchema> | null = null;

  /** Which tables callers are allowed to see, from configuration. */
  private readonly visibility: VisibilityRules;

  constructor(
    private readonly introspection: SchemaIntrospectionService,
    private readonly cache: SchemaCacheService,
    configService: ConfigService,
  ) {
    const safety = configService.get<SqlSafetyConfig>('sqlSafety')!;

    this.visibility = {
      allowedTables: safety.allowedTables,
      deniedTables: safety.deniedTables,
    };

    // Worth a line at boot: a schema that looks short is otherwise
    // indistinguishable from a database that really is that small.
    if (this.visibility.allowedTables.length > 0) {
      this.logger.log(
        `Restricted to ${this.visibility.allowedTables.length} allowed table(s)`,
      );
    }
    if (this.visibility.deniedTables.length > 0) {
      this.logger.log(
        `Hiding ${this.visibility.deniedTables.length} denied table(s)`,
      );
    }
  }

  /** The schema as callers may see it, with the deny and allow lists applied. */
  async getSchema(
    options: { refresh?: boolean } = {},
  ): Promise<DatabaseSchema> {
    return applyVisibility(await this.load(options), this.visibility);
  }

  /** The snapshot as read from the database, before any narrowing. */
  private async load(
    options: { refresh?: boolean } = {},
  ): Promise<DatabaseSchema> {
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
