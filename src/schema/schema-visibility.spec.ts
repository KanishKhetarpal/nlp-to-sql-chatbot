import { applyVisibility } from './schema-visibility';
import {
  DatabaseSchema,
  ForeignKeyMetadata,
  TableMetadata,
} from './schema.types';

const table = (
  name: string,
  foreignKeys: ForeignKeyMetadata[] = [],
): TableMetadata => ({
  schema: 'public',
  name,
  kind: 'table',
  comment: null,
  columns: [],
  primaryKey: ['id'],
  foreignKeys,
  uniqueConstraints: [],
});

const fk = (referencedTable: string): ForeignKeyMetadata => ({
  name: `fk_${referencedTable}`,
  columns: [`${referencedTable}_id`],
  referencedSchema: 'public',
  referencedTable,
  referencedColumns: ['id'],
});

const schemaOf = (...tables: TableMetadata[]): DatabaseSchema => ({
  database: 'test_db',
  schemas: ['public'],
  tables,
  introspectedAt: '2026-09-02T00:00:00.000Z',
});

const names = (schema: DatabaseSchema): string[] =>
  schema.tables.map((row) => row.name);

describe('applyVisibility', () => {
  const base = schemaOf(
    table('customers'),
    table('salaries'),
    table('orders', [fk('customers'), fk('salaries')]),
  );

  describe('with no rules configured', () => {
    it('changes nothing', () => {
      const result = applyVisibility(base, {
        allowedTables: [],
        deniedTables: [],
      });

      expect(result).toBe(base);
    });
  });

  describe('the deny list', () => {
    const denySalaries = { allowedTables: [], deniedTables: ['salaries'] };

    it('removes the table', () => {
      expect(names(applyVisibility(base, denySalaries))).toEqual([
        'customers',
        'orders',
      ]);
    });

    it('removes foreign keys that point at it', () => {
      // The serializer renders these as REFERENCES <table>, so one left
      // behind would name the hidden table in the prompt and invite a join
      // against something the model cannot see the shape of.
      const orders = applyVisibility(base, denySalaries).tables.find(
        (row) => row.name === 'orders',
      );

      expect(orders?.foreignKeys.map((key) => key.referencedTable)).toEqual([
        'customers',
      ]);
    });

    it('matches regardless of case', () => {
      expect(
        names(
          applyVisibility(base, {
            allowedTables: [],
            deniedTables: ['SALARIES'],
          }),
        ),
      ).not.toContain('salaries');
    });

    it('ignores a name that matches nothing', () => {
      expect(
        names(
          applyVisibility(base, { allowedTables: [], deniedTables: ['nope'] }),
        ),
      ).toEqual(['customers', 'salaries', 'orders']);
    });
  });

  describe('the allow list', () => {
    it('keeps only what is on it', () => {
      expect(
        names(
          applyVisibility(base, {
            allowedTables: ['customers', 'orders'],
            deniedTables: [],
          }),
        ),
      ).toEqual(['customers', 'orders']);
    });

    it('drops foreign keys to tables it excludes', () => {
      const result = applyVisibility(base, {
        allowedTables: ['orders'],
        deniedTables: [],
      });

      expect(result.tables[0].foreignKeys).toEqual([]);
    });

    it('is overruled by the deny list', () => {
      // A table on both lists is someone who has changed their mind, and the
      // safer reading of the two is the right one.
      expect(
        names(
          applyVisibility(base, {
            allowedTables: ['customers', 'salaries'],
            deniedTables: ['salaries'],
          }),
        ),
      ).toEqual(['customers']);
    });
  });

  describe('the snapshot it was given', () => {
    it('is never modified', () => {
      // The caller's copy is the cached one. Filtering it in place would
      // leave the cache holding a narrowed schema that no later change to
      // the configuration could widen again.
      applyVisibility(base, { allowedTables: [], deniedTables: ['salaries'] });

      expect(names(base)).toEqual(['customers', 'salaries', 'orders']);
      expect(base.tables[2].foreignKeys).toHaveLength(2);
    });

    it('keeps everything else about it', () => {
      const result = applyVisibility(base, {
        allowedTables: [],
        deniedTables: ['salaries'],
      });

      expect(result.database).toBe('test_db');
      expect(result.schemas).toEqual(['public']);
      expect(result.introspectedAt).toBe(base.introspectedAt);
    });

    it('leaves a table with nothing to strip exactly as it was', () => {
      const result = applyVisibility(base, {
        allowedTables: [],
        deniedTables: ['salaries'],
      });

      expect(result.tables[0]).toBe(base.tables[0]);
    });
  });
});
