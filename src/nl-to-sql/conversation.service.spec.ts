import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { ConversationTurn } from './nl-to-sql.types';

const turn = (question: string): ConversationTurn => ({
  question,
  askedAt: new Date().toISOString(),
  generation: {
    answerable: true,
    sql: 'SELECT 1;',
    explanation: 'why',
    tables: [],
  },
});

describe('ConversationService', () => {
  const build = (overrides: Record<string, number> = {}) => {
    const configService = {
      get: jest.fn().mockReturnValue({
        ttlSeconds: 3600,
        maxTurns: 20,
        maxSessions: 1000,
        ...overrides,
      }),
    } as unknown as ConfigService;

    return new ConversationService(configService);
  };

  let service: ConversationService;

  beforeEach(() => {
    service = build();
  });

  it('creates conversations with distinct ids and no turns', () => {
    const a = service.create();
    const b = service.create();

    expect(a.id).not.toBe(b.id);
    expect(a.turns).toEqual([]);
  });

  it('returns a conversation by id', () => {
    const created = service.create();

    expect(service.get(created.id).id).toBe(created.id);
  });

  it('throws for an unknown id', () => {
    expect(() => service.get('nope')).toThrow(NotFoundException);
  });

  it('records turns in order', () => {
    const { id } = service.create();

    service.record(id, turn('first'));
    service.record(id, turn('second'));

    expect(service.get(id).turns.map((t) => t.question)).toEqual([
      'first',
      'second',
    ]);
  });

  it('keeps only the most recent turns once the cap is reached', () => {
    service = build({ maxTurns: 3 });
    const { id } = service.create();

    for (const question of ['a', 'b', 'c', 'd', 'e']) {
      service.record(id, turn(question));
    }

    expect(service.get(id).turns.map((t) => t.question)).toEqual([
      'c',
      'd',
      'e',
    ]);
  });

  it('advances lastActiveAt when a turn is recorded', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { id, lastActiveAt } = service.create();

    jest.setSystemTime(new Date('2026-01-01T00:10:00.000Z'));
    const updated = service.record(id, turn('later'));

    expect(Date.parse(updated.lastActiveAt)).toBeGreaterThan(
      Date.parse(lastActiveAt),
    );
    jest.useRealTimers();
  });

  describe('expiry', () => {
    afterEach(() => jest.useRealTimers());

    it('treats a conversation idle past the TTL as gone', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      service = build({ ttlSeconds: 60 });
      const { id } = service.create();

      jest.setSystemTime(new Date('2026-01-01T00:02:00.000Z'));

      expect(() => service.get(id)).toThrow(NotFoundException);
    });

    it('keeps a conversation alive while it is being used', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      service = build({ ttlSeconds: 60 });
      const { id } = service.create();

      jest.setSystemTime(new Date('2026-01-01T00:00:45.000Z'));
      service.record(id, turn('still here'));

      jest.setSystemTime(new Date('2026-01-01T00:01:30.000Z'));

      expect(service.get(id).turns).toHaveLength(1);
    });
  });

  describe('capacity', () => {
    it('evicts the least recently active conversation when full', () => {
      service = build({ maxSessions: 2 });
      const first = service.create();
      const second = service.create();

      // Touching `first` makes `second` the least recently active.
      service.record(first.id, turn('keep me'));
      const third = service.create();

      expect(() => service.get(second.id)).toThrow(NotFoundException);
      expect(service.get(first.id).id).toBe(first.id);
      expect(service.get(third.id).id).toBe(third.id);
    });

    it('never holds more than the configured number of conversations', () => {
      service = build({ maxSessions: 3 });

      for (let i = 0; i < 10; i++) {
        service.create();
      }

      expect(service.stats().active).toBe(3);
    });
  });

  describe('resolve', () => {
    it('starts a new conversation when given no id', () => {
      expect(service.resolve().turns).toEqual([]);
      expect(service.stats().active).toBe(1);
    });

    it('continues an existing conversation when given its id', () => {
      const { id } = service.create();
      service.record(id, turn('earlier'));

      expect(service.resolve(id).turns).toHaveLength(1);
      expect(service.stats().active).toBe(1);
    });

    it('throws rather than silently starting over on an unknown id', () => {
      expect(() => service.resolve('nope')).toThrow(NotFoundException);
    });
  });

  it('deletes a conversation', () => {
    const { id } = service.create();

    service.delete(id);

    expect(() => service.get(id)).toThrow(NotFoundException);
    expect(() => service.delete(id)).toThrow(NotFoundException);
  });

  it('reports its bounds alongside the active count', () => {
    service = build({ maxSessions: 50, ttlSeconds: 120 });
    service.create();

    expect(service.stats()).toEqual({
      active: 1,
      maxSessions: 50,
      ttlSeconds: 120,
    });
  });
});
