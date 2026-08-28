import { Module } from '@nestjs/common';
import { NlToSqlModule } from '../nl-to-sql/nl-to-sql.module';
import { ExecutionModule } from '../execution/execution.module';
import { ChatController } from './chat.controller';

@Module({
  imports: [NlToSqlModule, ExecutionModule],
  controllers: [ChatController],
})
export class ChatModule {}
