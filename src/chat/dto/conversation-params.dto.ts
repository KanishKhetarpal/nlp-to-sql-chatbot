import { IsUUID } from 'class-validator';

export class ConversationParams {
  @IsUUID()
  id!: string;
}
