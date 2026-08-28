import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { SchemaModule } from './schema/schema.module';
import { LlmModule } from './llm/llm.module';
import { NlToSqlModule } from './nl-to-sql/nl-to-sql.module';
import { SqlSafetyModule } from './sql-safety/sql-safety.module';
import { ExecutionModule } from './execution/execution.module';
import { ChatModule } from './chat/chat.module';
import { ApiKeyGuard } from './common/guards/api-key.guard';
import { ApiConfig } from './config/configuration';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    HealthModule,
    SchemaModule,
    LlmModule,
    NlToSqlModule,
    SqlSafetyModule,
    ExecutionModule,
    ChatModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const api = configService.get<ApiConfig>('api')!;
        return [{ ttl: api.rateWindowSeconds * 1000, limit: api.rateLimit }];
      },
    }),
  ],
  providers: [
    // Order matters: authenticate first, then count the request against the
    // caller's rate limit. The reverse would let unauthenticated traffic
    // exhaust a legitimate client's budget.
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
