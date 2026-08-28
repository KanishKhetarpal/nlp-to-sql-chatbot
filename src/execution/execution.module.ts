import { Module } from '@nestjs/common';
import { QueryExecutorService } from './query-executor.service';
import { ResultFormatterService } from './result-formatter.service';
import { QueryAuditService } from './query-audit.service';

@Module({
  providers: [QueryExecutorService, ResultFormatterService, QueryAuditService],
  exports: [QueryExecutorService, ResultFormatterService, QueryAuditService],
})
export class ExecutionModule {}
