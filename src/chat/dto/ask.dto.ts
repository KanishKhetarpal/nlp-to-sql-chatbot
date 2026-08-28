import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

export class AskDto {
  /** The natural-language question. */
  @ApiProperty({
    example: 'How many customers are in the United Kingdom?',
    maxLength: 1000,
  })
  @IsString()
  @Length(1, 1000)
  question!: string;

  /** Continue an existing conversation. Omit to start a new one. */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  /** Generate and check the query, but stop before running it. */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
