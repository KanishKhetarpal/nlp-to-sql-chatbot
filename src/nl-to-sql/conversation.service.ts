import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ConversationConfig } from '../config/configuration';
import { Conversation, ConversationTurn } from './nl-to-sql.types';

/**
 * Holds conversations so a follow-up question can be resolved against what
 * came before ("and how many of those are in the UK?").
 *
 * In-memory and single-instance by design at this stage: a conversation is
 * cheap to recreate and worthless once the person has gone, so it is not worth
 * a datastore yet. Everything behind this class is a Map, and the API is
 * narrow enough that moving to Redis later is one file.
 *
 * Three bounds keep that map from growing without limit: a TTL per
 * conversation, a cap on turns kept per conversation, and a cap on how many
 * conversations exist at once.
 *
 * A conversation belongs to whoever started it. The owner is held beside the
 * conversation rather than on it, so it is never serialized into a response:
 * the identifier is derived from an API key and has no business being echoed
 * back to anyone.
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly conversations = new Map<string, Conversation>();
  /** Conversation id to the client that created it. Never sent to a caller. */
  private readonly owners = new Map<string, string>();
  private readonly config: ConversationConfig;

  constructor(configService: ConfigService) {
    this.config = configService.get<ConversationConfig>('conversation')!;
  }

  create(ownerId?: string): Conversation {
    this.evictExpired();
    this.evictOverflow();

    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: randomUUID(),
      createdAt: now,
      lastActiveAt: now,
      turns: [],
    };

    this.conversations.set(conversation.id, conversation);
    if (ownerId) {
      this.owners.set(conversation.id, ownerId);
    }
    return conversation;
  }

  /**
   * Returns the conversation, or throws if it is unknown, expired, or owned
   * by someone else.
   *
   * `ownerId` is undefined for internal callers and in open mode, where there
   * is one implicit client and nothing to tell apart.
   *
   * Someone else's conversation is reported as not found rather than
   * forbidden. "It exists, but it is not yours" is itself something the
   * caller did not know a moment ago.
   */
  get(id: string, ownerId?: string): Conversation {
    const conversation = this.conversations.get(id);

    if (!conversation || this.isExpired(conversation)) {
      if (conversation) {
        this.forget(id);
      }
      throw new NotFoundException(`Conversation "${id}" not found or expired`);
    }

    if (ownerId && !this.isOwnedBy(id, ownerId)) {
      throw new NotFoundException(`Conversation "${id}" not found or expired`);
    }

    return conversation;
  }

  /**
   * Returns the conversation for `id`, or a fresh one when `id` is undefined.
   * Lets a caller treat "continue this thread" and "start a new one" the same.
   */
  resolve(id?: string, ownerId?: string): Conversation {
    return id ? this.get(id, ownerId) : this.create(ownerId);
  }

  private isOwnedBy(id: string, ownerId: string): boolean {
    const owner = this.owners.get(id);

    // A conversation created before any key was configured has no owner, and
    // stays reachable rather than becoming permanently inaccessible.
    return owner === undefined || owner === ownerId;
  }

  /** Appends a turn, trimming the oldest once the per-conversation cap is hit. */
  record(id: string, turn: ConversationTurn): Conversation {
    const conversation = this.get(id);

    conversation.turns.push(turn);
    if (conversation.turns.length > this.config.maxTurns) {
      conversation.turns.splice(
        0,
        conversation.turns.length - this.config.maxTurns,
      );
    }

    conversation.lastActiveAt = new Date().toISOString();

    // Re-inserted so Map iteration order tracks recency, which is what the
    // overflow eviction below relies on.
    this.conversations.delete(id);
    this.conversations.set(id, conversation);

    return conversation;
  }

  delete(id: string, ownerId?: string): void {
    if (ownerId && this.conversations.has(id) && !this.isOwnedBy(id, ownerId)) {
      throw new NotFoundException(`Conversation "${id}" not found`);
    }

    if (!this.conversations.delete(id)) {
      throw new NotFoundException(`Conversation "${id}" not found`);
    }

    this.owners.delete(id);
  }

  /** Drops a conversation and the ownership record beside it. */
  private forget(id: string): void {
    this.conversations.delete(id);
    this.owners.delete(id);
  }

  stats(): { active: number; maxSessions: number; ttlSeconds: number } {
    this.evictExpired();

    return {
      active: this.conversations.size,
      maxSessions: this.config.maxSessions,
      ttlSeconds: this.config.ttlSeconds,
    };
  }

  private isExpired(conversation: Conversation): boolean {
    const age = Date.now() - Date.parse(conversation.lastActiveAt);
    return age > this.config.ttlSeconds * 1000;
  }

  private evictExpired(): void {
    for (const [id, conversation] of this.conversations) {
      if (this.isExpired(conversation)) {
        this.forget(id);
      }
    }
  }

  /** Drops least-recently-active conversations until one slot is free. */
  private evictOverflow(): void {
    while (this.conversations.size >= this.config.maxSessions) {
      const oldest = this.conversations.keys().next();
      if (oldest.done) {
        return;
      }

      this.forget(oldest.value);
      this.logger.warn(
        `Evicted conversation ${oldest.value}: at the ${this.config.maxSessions}-conversation limit`,
      );
    }
  }
}
