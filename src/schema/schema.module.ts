import { Module } from '@nestjs/common';
import { SchemaCacheService } from './schema-cache.service';
import { SchemaIntrospectionService } from './schema-introspection.service';
import { SchemaController } from './schema.controller';
import { SchemaSerializerService } from './schema-serializer.service';
import { SchemaService } from './schema.service';

@Module({
  controllers: [SchemaController],
  providers: [
    SchemaIntrospectionService,
    SchemaCacheService,
    SchemaSerializerService,
    SchemaService,
  ],
  exports: [SchemaService, SchemaSerializerService],
})
export class SchemaModule {}
