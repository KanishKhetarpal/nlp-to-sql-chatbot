import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip anything not on the DTO, and reject rather than ignore it, so a
      // typo in a field name is reported instead of silently doing nothing.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port') as number;

  await app.listen(port);
  Logger.log(`Application listening on port ${port}`, 'Bootstrap');
}
void bootstrap();
