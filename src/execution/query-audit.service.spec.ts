import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryAuditService } from './query-audit.service';
import { QueryAuditEntry } from './execution.types';

const entry = (
  overrides: Partial<Omit<QueryAuditEntry, 'at'>> = {},
): Omit<QueryAuditEntry, 'at'> => ({
  question: 'How many customers?',
  sql: 'SELECT count(*) FROM customers LIMIT 500',
  tables: ['customers'],
  outcome: 'succeeded',
  ...overrides,
});

const serviceWithLimit = (auditHistory: number): QueryAuditService =>
  new QueryAuditService({
    get: () => ({ auditHistory }),
  } as unknown as ConfigService);

describe('QueryAuditService', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message) => {
      logged.push(String(message));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('record', () => {
    it('stamps the entry with the time it was recorded', () => {
      const recorded = serviceWithLimit(10).record(entry());

      expect(Date.parse(recorded.at)).not.toBeNaN();
    });

    it('keeps the fields the caller supplied', () => {
      const recorded = serviceWithLimit(10).record(
        entry({ outcome: 'rejected', reason: 'denied_table' }),
      );

      expect(recorded).toMatchObject({
        outcome: 'rejected',
        reason: 'denied_table',
        tables: ['customers'],
      });
    });

    it('writes one structured line per query', () => {
      serviceWithLimit(10).record(entry({ rowCount: 3, durationMs: 12 }));

      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0])).toMatchObject({
        outcome: 'succeeded',
        question: 'How many customers?',
        rowCount: 3,
        durationMs: 12,
      });
    });

    it('logs valid JSON even for a question containing quotes', () => {
      // The log line is the copy that survives a restart, so it has to stay
      // machine-readable whatever the question was.
      serviceWithLimit(10).record(
        entry({ question: 'Who said "hello", exactly?' }),
      );

      expect(() => {
        JSON.parse(logged[0]);
      }).not.toThrow();
      expect(JSON.parse(logged[0])).toMatchObject({
        question: 'Who said "hello", exactly?',
      });
    });
  });

  describe('recent', () => {
    it('returns the newest entry first', () => {
      const service = serviceWithLimit(10);
      service.record(entry({ question: 'first' }));
      service.record(entry({ question: 'second' }));

      expect(service.recent().map((row) => row.question)).toEqual([
        'second',
        'first',
      ]);
    });

    it('returns the newest N, not the oldest N', () => {
      const service = serviceWithLimit(10);
      ['a', 'b', 'c'].forEach((question) =>
        service.record(entry({ question })),
      );

      expect(service.recent(2).map((row) => row.question)).toEqual(['c', 'b']);
    });

    it('does not reorder the stored entries', () => {
      // recent() reverses to put the newest first. Reversing the stored array
      // rather than a copy would flip the ring itself, and the next caller
      // would be handed the oldest entries as the newest.
      const service = serviceWithLimit(10);
      ['a', 'b', 'c'].forEach((question) =>
        service.record(entry({ question })),
      );

      const first = service.recent().map((row) => row.question);
      const second = service.recent().map((row) => row.question);

      expect(first).toEqual(['c', 'b', 'a']);
      expect(second).toEqual(first);
    });

    it('is empty before anything has been asked', () => {
      expect(serviceWithLimit(10).recent()).toEqual([]);
    });
  });

  describe('scoping to a client', () => {
    const alice = entry({ question: 'alice', clientId: 'client-a' });
    const bob = entry({ question: 'bob', clientId: 'client-b' });

    it('shows a caller only their own questions', () => {
      // The defect this closes: the trail was global, so any key holder could
      // read every other caller's questions and the SQL they produced.
      const service = serviceWithLimit(10);
      service.record(alice);
      service.record(bob);

      expect(service.recent(50, 'client-a').map((row) => row.question)).toEqual(
        ['alice'],
      );
    });

    it('shows everything when the caller has no identity', () => {
      // Open mode: no keys configured, one implicit caller, nothing to hide.
      const service = serviceWithLimit(10);
      service.record(alice);
      service.record(bob);

      expect(service.recent()).toHaveLength(2);
    });

    it('does not show unattributed entries to an identified caller', () => {
      // "Unattributed" must not become a way to see everything.
      const service = serviceWithLimit(10);
      service.record(entry({ question: 'from nobody' }));

      expect(service.recent(50, 'client-a')).toEqual([]);
    });

    it('applies the limit after narrowing, not before', () => {
      // Filtering a page that was already cut would hand back fewer rows than
      // asked for, and sometimes none at all.
      const service = serviceWithLimit(10);
      service.record(bob);
      service.record(bob);
      service.record(alice);
      service.record(bob);

      expect(service.recent(2, 'client-a')).toHaveLength(1);
    });

    it('records which client asked in the log line', () => {
      const service = serviceWithLimit(10);
      service.record(alice);

      expect(JSON.parse(logged[0])).toMatchObject({ clientId: 'client-a' });
    });
  });

  describe('the in-memory ring', () => {
    it('drops the oldest entries once it is full', () => {
      // Bounded on purpose: the trail is kept for inspection, and an
      // unbounded array would grow for as long as the process lives.
      const service = serviceWithLimit(3);
      ['a', 'b', 'c', 'd', 'e'].forEach((question) =>
        service.record(entry({ question })),
      );

      expect(service.size()).toBe(3);
      expect(service.recent().map((row) => row.question)).toEqual([
        'e',
        'd',
        'c',
      ]);
    });

    it('holds entries from every client, and separates them on the way out', () => {
      // One ring for the process; the filtering is what keeps callers apart.
      const service = serviceWithLimit(10);
      service.record(entry({ question: 'alice one', clientId: 'client-a' }));
      service.record(entry({ question: 'bob one', clientId: 'client-b' }));
      service.record(entry({ question: 'alice two', clientId: 'client-a' }));

      expect(service.size()).toBe(3);
      expect(service.recent(50, 'client-a').map((row) => row.question)).toEqual(
        ['alice two', 'alice one'],
      );
    });

    it('still logs the entries it drops', () => {
      // Losing a line from the ring must not lose it from the trail.
      const service = serviceWithLimit(2);
      ['a', 'b', 'c'].forEach((question) =>
        service.record(entry({ question })),
      );

      expect(service.size()).toBe(2);
      expect(logged).toHaveLength(3);
    });
  });
});
