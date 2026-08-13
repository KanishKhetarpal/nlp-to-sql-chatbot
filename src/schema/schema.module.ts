import { Module } from '@nestjs/common';
import { SchemaCacheService } from './schema-cache.service';
import { SchemaIntrospectionService } from './schema-introspection.service';
import { SchemaService } from './schema.service';

@Module({
  providers: [SchemaIntrospectionService, SchemaCacheService, SchemaService],
  exports: [SchemaService],
})
export class SchemaModule {}
