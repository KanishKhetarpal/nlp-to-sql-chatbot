import { IsBoolean, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class AskDto {
  /** The natural-language question. */
  @IsString()
  @Length(1, 1000)
  question!: string;

  /** Continue an existing conversation. Omit to start a new one. */
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  /** Generate and check the query, but stop before running it. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
