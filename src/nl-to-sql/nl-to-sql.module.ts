import { Module } from '@nestjs/common';
import { SchemaModule } from '../schema/schema.module';
import { LlmModule } from '../llm/llm.module';
import { SqlSafetyModule } from '../sql-safety/sql-safety.module';
import { ExecutionModule } from '../execution/execution.module';
import { ConversationService } from './conversation.service';
import { PromptBuilderService } from './prompt-builder.service';
import { SqlGenerationService } from './sql-generation.service';
import { AskService } from './ask.service';

@Module({
  imports: [SchemaModule, LlmModule, SqlSafetyModule, ExecutionModule],
  providers: [
    PromptBuilderService,
    ConversationService,
    SqlGenerationService,
    AskService,
  ],
  exports: [AskService, SqlGenerationService, ConversationService],
})
export class NlToSqlModule {}
