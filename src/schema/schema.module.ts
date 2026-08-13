import { Module } from '@nestjs/common';
import { SchemaIntrospectionService } from './schema-introspection.service';

@Module({
  providers: [SchemaIntrospectionService],
  exports: [SchemaIntrospectionService],
})
export class SchemaModule {}
