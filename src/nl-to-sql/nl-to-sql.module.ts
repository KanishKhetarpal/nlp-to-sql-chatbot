import { Module } from '@nestjs/common';
import { SchemaModule } from '../schema/schema.module';
import { LlmModule } from '../llm/llm.module';
import { ConversationService } from './conversation.service';
import { PromptBuilderService } from './prompt-builder.service';
import { SqlGenerationService } from './sql-generation.service';

@Module({
  imports: [SchemaModule, LlmModule],
  providers: [PromptBuilderService, ConversationService, SqlGenerationService],
  exports: [SqlGenerationService, ConversationService],
})
export class NlToSqlModule {}
