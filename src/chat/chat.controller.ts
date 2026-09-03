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
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { AskService } from '../nl-to-sql/ask.service';
import type { AskResponse } from '../nl-to-sql/ask.service';
import { ConversationService } from '../nl-to-sql/conversation.service';
import { QueryAuditService } from '../execution/query-audit.service';
import type { QueryAuditEntry } from '../execution/execution.types';
import type { Conversation } from '../nl-to-sql/nl-to-sql.types';
import { ClientId } from '../common/decorators/client-id.decorator';
import { AskDto } from './dto/ask.dto';
import { ConversationParams } from './dto/conversation-params.dto';

/**
 * The chat surface.
 *
 * Asking a question is a POST because it costs money and runs a query — it is
 * not a safe, cacheable read, whatever the shape of the response suggests.
 *
 * Everything here is scoped to the API key that asked: a conversation belongs
 * to whoever started it, and the audit trail shows that caller's own queries.
 * With no keys configured there is one implicit caller and nothing to scope.
 */
@ApiTags('chat')
@ApiSecurity('api-key')
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
  @ApiOperation({
    summary: 'Ask a question',
    description:
      'Generates SQL, checks it is a bounded read-only query, runs it and returns the rows. Answers 200 for every outcome the pipeline reached, including a refusal — read the status field.',
  })
  @Post('ask')
  @HttpCode(HttpStatus.OK)
  askQuestion(
    @Body() body: AskDto,
    @ClientId() clientId?: string,
  ): Promise<AskResponse> {
    return this.ask.ask({
      question: body.question,
      conversationId: body.conversationId,
      dryRun: body.dryRun,
      clientId,
    });
  }

  /** Start a conversation without asking anything yet. */
  @ApiOperation({ summary: 'Start a conversation' })
  @Post('sessions')
  createSession(@ClientId() clientId?: string): Conversation {
    return this.conversations.create(clientId);
  }

  /** The turns so far, oldest first. */
  @ApiOperation({ summary: 'Conversation history' })
  @Get('sessions/:id')
  getSession(
    @Param() params: ConversationParams,
    @ClientId() clientId?: string,
  ): Conversation {
    return this.conversations.get(params.id, clientId);
  }

  @ApiOperation({ summary: 'Discard a conversation' })
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteSession(
    @Param() params: ConversationParams,
    @ClientId() clientId?: string,
  ): void {
    this.conversations.delete(params.id, clientId);
  }

  /** Recent queries by this caller, newest first — the audit trail. */
  @ApiOperation({
    summary: 'Recent queries, newest first',
    description:
      'Scoped to the API key that asks. With no keys configured every query is returned, because there is only one caller.',
  })
  @Get('audit')
  recentQueries(
    @Query('limit') limit?: string,
    @ClientId() clientId?: string,
  ): QueryAuditEntry[] {
    const parsed = Number.parseInt(limit ?? '', 10);
    return this.audit.recent(
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50,
      clientId,
    );
  }
}
