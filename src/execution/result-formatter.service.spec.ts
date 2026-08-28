import { ResultFormatterService } from './result-formatter.service';
import { QueryResult } from './execution.types';

const result = (overrides: Partial<QueryResult> = {}): QueryResult => ({
  columns: ['id', 'country'],
  rows: [
    { id: 1, country: 'United Kingdom' },
    { id: 2, country: 'United States' },
  ],
  rowCount: 2,
  truncated: false,
  durationMs: 4,
  ...overrides,
});

describe('ResultFormatterService', () => {
  const service = new ResultFormatterService();

  describe('toTable', () => {
    it('renders headers, a rule and the rows', () => {
      const lines = service.toTable(result()).split('\n');

      expect(lines[0]).toContain('id');
      expect(lines[0]).toContain('country');
      expect(lines[1]).toMatch(/^-+\s+-+$/);
      expect(lines[2]).toContain('United Kingdom');
    });

    it('pads columns to a consistent width', () => {
      const lines = service.toTable(result()).split('\n');

      // Every row starts at the same offset for the second column.
      const offsets = lines
        .slice(2)
        .map((line) => line.indexOf('United'))
        .filter((offset) => offset > 0);
      expect(new Set(offsets).size).toBe(1);
    });

    it('says so explicitly when there are no rows', () => {
      const output = service.toTable(
        result({ rows: [], rowCount: 0, columns: ['id'] }),
      );

      expect(output).toContain('(no rows)');
    });

    it('handles a result with no columns at all', () => {
      expect(
        service.toTable(result({ columns: [], rows: [], rowCount: 0 })),
      ).toBe('(no columns)');
    });

    it('writes NULL rather than leaving a blank cell', () => {
      // A blank cell and a missing value look identical but mean different
      // things, so the distinction is spelled out.
      const output = service.toTable(
        result({ rows: [{ id: 1, country: null }], rowCount: 1 }),
      );

      expect(output).toContain('NULL');
    });

    it('shortens a value that would stretch the table', () => {
      const output = service.toTable(
        result({
          rows: [{ id: 1, country: 'x'.repeat(200) }],
          rowCount: 1,
        }),
      );

      expect(output).toContain('…');
      expect(Math.max(...output.split('\n').map((l) => l.length))).toBeLessThan(
        80,
      );
    });

    it('renders dates and objects readably', () => {
      const output = service.toTable(
        result({
          columns: ['at', 'meta'],
          rows: [{ at: new Date('2026-01-01T00:00:00Z'), meta: { a: 1 } }],
          rowCount: 1,
        }),
      );

      expect(output).toContain('2026-01-01T00:00:00.000Z');
      expect(output).toContain('{"a":1}');
    });
  });

  describe('summarize', () => {
    it('states a single scalar as the answer', () => {
      expect(
        service.summarize(
          result({ columns: ['count'], rows: [{ count: 42 }], rowCount: 1 }),
        ),
      ).toBe('count: 42');
    });

    it('spells out a single multi-column row', () => {
      expect(
        service.summarize(
          result({ rows: [{ id: 1, country: 'UK' }], rowCount: 1 }),
        ),
      ).toBe('1 row — id = 1, country = UK');
    });

    it('counts the rows and names the columns', () => {
      expect(service.summarize(result())).toBe(
        '2 rows, 2 columns (id, country).',
      );
    });

    it('says nothing matched rather than reporting zero rows', () => {
      expect(
        service.summarize(result({ rows: [], rowCount: 0 })),
      ).toBe('No rows matched.');
    });

    it('warns when the answer was cut off at the cap', () => {
      // Otherwise a truncated page reads as the complete answer.
      expect(service.summarize(result({ truncated: true }))).toContain(
        'cut off at the row limit',
      );
    });
  });
});
