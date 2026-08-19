import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { SchemaModule } from './schema/schema.module';
import { LlmModule } from './llm/llm.module';
import { NlToSqlModule } from './nl-to-sql/nl-to-sql.module';
import { SqlSafetyModule } from './sql-safety/sql-safety.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    HealthModule,
    SchemaModule,
    LlmModule,
    NlToSqlModule,
    SqlSafetyModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
