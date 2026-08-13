import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntrospectionConfig } from '../config/configuration';
import { DatabaseSchema } from './schema.types';

export interface CacheStatus {
  enabled: boolean;
  cached: boolean;
  ttlSeconds: number;
  /** ISO timestamp the current entry goes stale, or null when nothing is cached. */
  expiresAt: string | null;
}

/**
 * Holds the most recent schema snapshot in memory for a configured TTL.
 *
 * Introspection is a handful of catalog queries — cheap, but not free, and the
 * result is needed on every natural-language question the service answers.
 * A schema also changes rarely, so a short TTL trades a little staleness for
 * not re-reading the catalogs on every request.
 *
 * In-process by design: a snapshot is derived data, and rebuilding it costs
 * one round trip, so it is not worth a shared cache and the invalidation
 * problem that comes with one.
 */
@Injectable()
export class SchemaCacheService {
  private readonly logger = new Logger(SchemaCacheService.name);
  private readonly ttlMs: number;

  private snapshot: DatabaseSchema | null = null;
  private expiresAt = 0;

  constructor(configService: ConfigService) {
    const introspection =
      configService.get<IntrospectionConfig>('introspection')!;
    this.ttlMs = introspection.cacheTtlSeconds * 1000;
  }

  private get enabled(): boolean {
    return this.ttlMs > 0;
  }

  /** Returns the cached snapshot, or null when absent, expired or disabled. */
  get(): DatabaseSchema | null {
    if (!this.enabled || !this.snapshot) {
      return null;
    }

    if (Date.now() >= this.expiresAt) {
      this.logger.debug('Cached schema expired');
      this.snapshot = null;
      this.expiresAt = 0;
      return null;
    }

    return this.snapshot;
  }

  set(snapshot: DatabaseSchema): void {
    if (!this.enabled) {
      return;
    }

    this.snapshot = snapshot;
    this.expiresAt = Date.now() + this.ttlMs;
  }

  invalidate(): void {
    this.snapshot = null;
    this.expiresAt = 0;
  }

  status(): CacheStatus {
    const cached = this.get() !== null;

    return {
      enabled: this.enabled,
      cached,
      ttlSeconds: this.ttlMs / 1000,
      expiresAt: cached ? new Date(this.expiresAt).toISOString() : null,
    };
  }
}
