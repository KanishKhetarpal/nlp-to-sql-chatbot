import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SchemaIntrospectionService } from './schema-introspection.service';

/**
 * The catalog SQL itself is exercised against a real Postgres in the e2e
 * suite. These tests cover the part with branching logic: folding three flat
 * result sets into one table-per-entry structure.
 */
describe('SchemaIntrospectionService', () => {
  let service: SchemaIntrospectionService;
  let query: jest.Mock;

  const tableRows = [
    {
      table_schema: 'public',
      table_name: 'customers',
      relkind: 'r',
      table_comment: 'People who have registered an account.',
    },
    {
      table_schema: 'public',
      table_name: 'orders',
      relkind: 'r',
      table_comment: null,
    },
    {
      table_schema: 'public',
      table_name: 'active_customers',
      relkind: 'v',
      table_comment: null,
    },
  ];

  const columnRows = [
    {
      table_schema: 'public',
      table_name: 'customers',
      column_name: 'id',
      ordinal_position: 1,
      data_type: 'integer',
      is_nullable: false,
      column_default: "nextval('customers_id_seq'::regclass)",
      column_comment: null,
    },
    {
      table_schema: 'public',
      table_name: 'customers',
      column_name: 'email',
      ordinal_position: 2,
      data_type: 'character varying(255)',
      is_nullable: false,
      column_default: null,
      column_comment: 'Login address.',
    },
    {
      table_schema: 'public',
      table_name: 'orders',
      column_name: 'id',
      ordinal_position: 1,
      data_type: 'integer',
      is_nullable: false,
      column_default: null,
      column_comment: null,
    },
    {
      table_schema: 'public',
      table_name: 'orders',
      column_name: 'customer_id',
      ordinal_position: 2,
      data_type: 'integer',
      is_nullable: true,
      column_default: null,
      column_comment: null,
    },
  ];

  const constraintRows = [
    {
      table_schema: 'public',
      table_name: 'customers',
      constraint_name: 'customers_pkey',
      constraint_type: 'p',
      column_names: ['id'],
      referenced_schema: null,
      referenced_table: null,
      referenced_columns: null,
    },
    {
      table_schema: 'public',
      table_name: 'customers',
      constraint_name: 'customers_email_key',
      constraint_type: 'u',
      column_names: ['email'],
      referenced_schema: null,
      referenced_table: null,
      referenced_columns: null,
    },
    {
      table_schema: 'public',
      table_name: 'orders',
      constraint_name: 'orders_customer_id_fkey',
      constraint_type: 'f',
      column_names: ['customer_id'],
      referenced_schema: 'public',
      referenced_table: 'customers',
      referenced_columns: ['id'],
    },
  ];

  beforeEach(async () => {
    // Each catalog query is identified by the table it reads from.
    query = jest.fn((sql: string) => {
      if (sql.includes('pg_constraint')) return Promise.resolve(constraintRows);
      if (sql.includes('pg_attribute a')) return Promise.resolve(columnRows);
      return Promise.resolve(tableRows);
    });

    const dataSource = {
      options: { database: 'test_db' },
      query,
    } as unknown as DataSource;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchemaIntrospectionService,
        { provide: getDataSourceToken(), useValue: dataSource },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue({
              schemas: ['public'],
              cacheTtlSeconds: 300,
            }),
          },
        },
      ],
    }).compile();

    service = module.get(SchemaIntrospectionService);
  });

  it('reports the database and schemas it read', async () => {
    const snapshot = await service.introspect();

    expect(snapshot.database).toBe('test_db');
    expect(snapshot.schemas).toEqual(['public']);
    expect(Date.parse(snapshot.introspectedAt)).not.toBeNaN();
  });

  it('returns every relation it was given', async () => {
    const snapshot = await service.introspect();

    expect(snapshot.tables.map((t) => t.name)).toEqual([
      'customers',
      'orders',
      'active_customers',
    ]);
  });

  it('attaches columns to the table they belong to', async () => {
    const snapshot = await service.introspect();
    const customers = snapshot.tables.find((t) => t.name === 'customers')!;

    expect(customers.columns.map((c) => c.name)).toEqual(['id', 'email']);
    expect(customers.columns[1]).toMatchObject({
      dataType: 'character varying(255)',
      isNullable: false,
      comment: 'Login address.',
    });
  });

  it('flags primary key columns and exposes the key', async () => {
    const snapshot = await service.introspect();
    const customers = snapshot.tables.find((t) => t.name === 'customers')!;

    expect(customers.primaryKey).toEqual(['id']);
    expect(customers.columns.find((c) => c.name === 'id')!.isPrimaryKey).toBe(
      true,
    );
    expect(customers.columns.find((c) => c.name === 'email')!.isPrimaryKey).toBe(
      false,
    );
  });

  it('maps foreign keys to their referenced table', async () => {
    const snapshot = await service.introspect();
    const orders = snapshot.tables.find((t) => t.name === 'orders')!;

    expect(orders.foreignKeys).toEqual([
      {
        name: 'orders_customer_id_fkey',
        columns: ['customer_id'],
        referencedSchema: 'public',
        referencedTable: 'customers',
        referencedColumns: ['id'],
      },
    ]);
  });

  it('separates unique constraints from the primary key', async () => {
    const snapshot = await service.introspect();
    const customers = snapshot.tables.find((t) => t.name === 'customers')!;

    expect(customers.uniqueConstraints).toEqual([
      { name: 'customers_email_key', columns: ['email'] },
    ]);
  });

  it('distinguishes views from ordinary tables', async () => {
    const snapshot = await service.introspect();

    expect(snapshot.tables.find((t) => t.name === 'customers')!.kind).toBe(
      'table',
    );
    expect(
      snapshot.tables.find((t) => t.name === 'active_customers')!.kind,
    ).toBe('view');
  });

  it('handles a relation with no columns or constraints', async () => {
    const snapshot = await service.introspect();
    const view = snapshot.tables.find((t) => t.name === 'active_customers')!;

    expect(view.columns).toEqual([]);
    expect(view.primaryKey).toEqual([]);
    expect(view.foreignKeys).toEqual([]);
    expect(view.uniqueConstraints).toEqual([]);
  });

  it('restricts every catalog query to the configured schemas', async () => {
    await service.introspect();

    expect(query).toHaveBeenCalledTimes(3);
    for (const [, params] of query.mock.calls) {
      expect(params as unknown[]).toContainEqual(['public']);
    }
  });
});
