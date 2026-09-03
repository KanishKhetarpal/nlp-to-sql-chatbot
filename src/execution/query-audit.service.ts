import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionConfig } from '../config/configuration';
import { QueryAuditEntry } from './execution.types';

/**
 * Records every question that reached the database, and every one that was
 * refused before it got there.
 *
 * Entries record which client asked, so one caller cannot read another's
 * questions back out of the trail. With no API keys configured there is one
 * implicit caller and nothing to separate.
 *
 * The trail is written to the log and kept in a bounded in-memory ring for
 * inspection. It is deliberately *not* written to the database being queried:
 * that connection is read-only by design, and the target database belongs to
 * someone else — an audit table is the operator's to place, not this
 * service's to create.
 */
@Injectable()
export class QueryAuditService {
  private readonly logger = new Logger('QueryAudit');
  private readonly entries: QueryAuditEntry[] = [];
  private readonly limit: number;

  constructor(configService: ConfigService) {
    this.limit = configService.get<ExecutionConfig>('execution')!.auditHistory;
  }

  record(entry: Omit<QueryAuditEntry, 'at'>): QueryAuditEntry {
    const recorded: QueryAuditEntry = {
      at: new Date().toISOString(),
      ...entry,
    };

    this.entries.push(recorded);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }

    // One structured line per query, so the trail survives a restart even
    // though the in-memory ring does not.
    this.logger.log(
      JSON.stringify({
        outcome: recorded.outcome,
        question: recorded.question,
        sql: recorded.sql,
        tables: recorded.tables,
        rowCount: recorded.rowCount,
        durationMs: recorded.durationMs,
        reason: recorded.reason,
        conversationId: recorded.conversationId,
        clientId: recorded.clientId,
      }),
    );

    return recorded;
  }

  /**
   * Most recent entries, newest first.
   *
   * Narrowed to one client when `clientId` is given. The match is strict:
   * an entry with no client is not shown to a caller that has one, because
   * "unattributed" must not become a way to see everything.
   */
  recent(limit = 50, clientId?: string): QueryAuditEntry[] {
    const visible = clientId
      ? this.entries.filter((entry) => entry.clientId === clientId)
      : this.entries;

    return visible.slice(-limit).reverse();
  }

  size(): number {
    return this.entries.length;
  }
}
