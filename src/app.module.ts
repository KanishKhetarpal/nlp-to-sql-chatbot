import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { SchemaModule } from './schema/schema.module';

@Module({
  imports: [ConfigModule, DatabaseModule, HealthModule, SchemaModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
