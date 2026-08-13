import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { CacheStatus } from './schema-cache.service';
import { SchemaSerializerService } from './schema-serializer.service';
import { SchemaService } from './schema.service';
import { DatabaseSchema } from './schema.types';

interface SchemaResponse extends DatabaseSchema {
  cache: CacheStatus;
}

/**
 * Read-only view of the database metadata the NL-to-SQL pipeline works from.
 *
 * Useful on its own for confirming what the service can actually see, and it
 * is the fastest way to check that a schema change has been picked up.
 *
 * Query parameters are parsed by hand here; DTOs and a global validation pipe
 * arrive with the chat API, and it is not worth half-introducing them for
 * three optional flags.
 */
@Controller('schema')
export class SchemaController {
  constructor(
    private readonly schemaService: SchemaService,
    private readonly serializer: SchemaSerializerService,
  ) {}

  /** The full snapshot as JSON. */
  @Get()
  async getSchema(@Query('refresh') refresh?: string): Promise<SchemaResponse> {
    const schema = await this.schemaService.getSchema({
      refresh: isTrue(refresh),
    });

    return { ...schema, cache: this.schemaService.cacheStatus() };
  }

  /**
   * The same snapshot rendered as prompt-ready DDL. Served as text/plain
   * because it is meant to be read, and copied, as text.
   */
  @Get('prompt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async getPrompt(
    @Query('tables') tables?: string,
    @Query('comments') comments?: string,
    @Query('defaults') defaults?: string,
    @Query('refresh') refresh?: string,
  ): Promise<string> {
    const schema = await this.schemaService.getSchema({
      refresh: isTrue(refresh),
    });

    return this.serializer.serialize(schema, {
      tables: splitList(tables),
      includeComments: comments === undefined ? undefined : isTrue(comments),
      includeDefaults: isTrue(defaults),
    });
  }

  /** Drops the cached snapshot and reads the catalogs again. */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(): Promise<SchemaResponse> {
    const schema = await this.schemaService.refresh();

    return { ...schema, cache: this.schemaService.cacheStatus() };
  }
}

function isTrue(value?: string): boolean {
  return value === '' || value === 'true' || value === '1';
}

function splitList(value?: string): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return items.length > 0 ? items : undefined;
}
