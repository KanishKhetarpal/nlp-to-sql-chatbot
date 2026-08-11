import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseConfig } from '../config/configuration';

/**
 * Owns the TypeORM connection to the target Postgres database.
 *
 * Connection settings come from ConfigService rather than process.env, so the
 * values here are the ones already validated at boot. Entities are discovered
 * by glob, which keeps this module untouched as feature modules are added.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const database = configService.get<DatabaseConfig>(
          'database',
        ) as DatabaseConfig;

        return {
          type: 'postgres' as const,
          host: database.host,
          port: database.port,
          username: database.username,
          password: database.password,
          database: database.name,
          autoLoadEntities: true,
          synchronize: database.synchronize,
          logging: database.logging,
        };
      },
    }),
  ],
})
export class DatabaseModule {}
