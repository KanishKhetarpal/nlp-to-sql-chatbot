import { Module } from '@nestjs/common';
import { SqlValidatorService } from './sql-validator.service';

@Module({
  providers: [SqlValidatorService],
  exports: [SqlValidatorService],
})
export class SqlSafetyModule {}
