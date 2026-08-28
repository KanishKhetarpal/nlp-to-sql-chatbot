import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

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

  app.useGlobalFilters(new AllExceptionsFilter());

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('NLP-to-SQL Chatbot')
      .setDescription(
        'Ask questions in English; get back validated, bounded SQL and its results.',
      )
      .setVersion('1.0')
      .addApiKey({ type: 'apiKey', name: 'x-api-key', in: 'header' }, 'api-key')
      .build(),
  );
  SwaggerModule.setup('docs', app, document);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port') as number;

  await app.listen(port);
  Logger.log(`Application listening on port ${port}`, 'Bootstrap');
  Logger.log(`API documentation at http://localhost:${port}/docs`, 'Bootstrap');
}
void bootstrap();
