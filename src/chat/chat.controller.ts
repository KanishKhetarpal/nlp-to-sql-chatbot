import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { AskService } from '../nl-to-sql/ask.service';
import type { AskResponse } from '../nl-to-sql/ask.service';
import { ConversationService } from '../nl-to-sql/conversation.service';
import { QueryAuditService } from '../execution/query-audit.service';
import type { QueryAuditEntry } from '../execution/execution.types';
import type { Conversation } from '../nl-to-sql/nl-to-sql.types';
import { AskDto } from './dto/ask.dto';
import { ConversationParams } from './dto/conversation-params.dto';

/**
 * The chat surface.
 *
 * Asking a question is a POST because it costs money and runs a query — it is
 * not a safe, cacheable read, whatever the shape of the response suggests.
 */
@Controller('chat')
export class ChatController {
  constructor(
    private readonly ask: AskService,
    private readonly conversations: ConversationService,
    private readonly audit: QueryAuditService,
  ) {}

  /**
   * Ask a question.
   *
   * Always 200 when the pipeline ran to a conclusion: "the schema cannot
   * answer that" and "the query was refused" are answers, not transport
   * failures, and the body's `status` says which happened.
   */
  @Post('ask')
  @HttpCode(HttpStatus.OK)
  askQuestion(@Body() body: AskDto): Promise<AskResponse> {
    return this.ask.ask({
      question: body.question,
      conversationId: body.conversationId,
      dryRun: body.dryRun,
    });
  }

  /** Start a conversation without asking anything yet. */
  @Post('sessions')
  createSession(): Conversation {
    return this.conversations.create();
  }

  /** The turns so far, oldest first. */
  @Get('sessions/:id')
  getSession(@Param() params: ConversationParams): Conversation {
    return this.conversations.get(params.id);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteSession(@Param() params: ConversationParams): void {
    this.conversations.delete(params.id);
  }

  /** Recent queries, newest first — the audit trail. */
  @Get('audit')
  recentQueries(@Query('limit') limit?: string): QueryAuditEntry[] {
    const parsed = Number.parseInt(limit ?? '', 10);
    return this.audit.recent(
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50,
    );
  }
}
