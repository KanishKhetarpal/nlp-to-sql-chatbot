import { SchemaSerializerService } from './schema-serializer.service';
import { DatabaseSchema, TableMetadata } from './schema.types';

const customers: TableMetadata = {
  schema: 'public',
  name: 'customers',
  kind: 'table',
  comment: 'People who have registered an account.',
  primaryKey: ['id'],
  uniqueConstraints: [{ name: 'customers_email_key', columns: ['email'] }],
  foreignKeys: [],
  columns: [
    {
      name: 'id',
      position: 1,
      dataType: 'integer',
      isNullable: false,
      defaultValue: "nextval('customers_id_seq'::regclass)",
      comment: null,
      isPrimaryKey: true,
    },
    {
      name: 'email',
      position: 2,
      dataType: 'character varying(255)',
      isNullable: false,
      defaultValue: null,
      comment: 'Login address.',
      isPrimaryKey: false,
    },
    {
      name: 'city',
      position: 3,
      dataType: 'character varying(100)',
      isNullable: true,
      defaultValue: null,
      comment: null,
      isPrimaryKey: false,
    },
  ],
};

const orders: TableMetadata = {
  schema: 'public',
  name: 'orders',
  kind: 'table',
  comment: null,
  primaryKey: ['id'],
  uniqueConstraints: [],
  foreignKeys: [
    {
      name: 'orders_customer_id_fkey',
      columns: ['customer_id'],
      referencedSchema: 'public',
      referencedTable: 'customers',
      referencedColumns: ['id'],
    },
  ],
  columns: [
    {
      name: 'id',
      position: 1,
      dataType: 'integer',
      isNullable: false,
      defaultValue: null,
      comment: null,
      isPrimaryKey: true,
    },
    {
      name: 'customer_id',
      position: 2,
      dataType: 'integer',
      isNullable: false,
      defaultValue: null,
      comment: null,
      isPrimaryKey: false,
    },
  ],
};

const activeCustomers: TableMetadata = {
  schema: 'public',
  name: 'active_customers',
  kind: 'view',
  comment: null,
  primaryKey: [],
  uniqueConstraints: [],
  foreignKeys: [],
  columns: [
    {
      name: 'id',
      position: 1,
      dataType: 'integer',
      isNullable: true,
      defaultValue: null,
      comment: null,
      isPrimaryKey: false,
    },
  ],
};

const schema = (
  tables: TableMetadata[],
  schemas: string[] = ['public'],
): DatabaseSchema => ({
  database: 'test_db',
  schemas,
  tables,
  introspectedAt: '2026-01-01T00:00:00.000Z',
});

describe('SchemaSerializerService', () => {
  const service = new SchemaSerializerService();

  it('renders a table as a CREATE TABLE statement', () => {
    const output = service.serialize(schema([customers]));

    expect(output).toContain('CREATE TABLE customers (');
    expect(output).toContain('  id integer NOT NULL,');
    expect(output).toContain('  city character varying(100),');
    expect(output.trimEnd().endsWith(');')).toBe(true);
  });

  it('includes the primary key, unique and foreign key constraints', () => {
    const output = service.serialize(schema([customers, orders]));

    expect(output).toContain('PRIMARY KEY (id)');
    expect(output).toContain('UNIQUE (email)');
    expect(output).toContain(
      'FOREIGN KEY (customer_id) REFERENCES customers (id)',
    );
  });

  it('attaches comments to the table and its columns', () => {
    const output = service.serialize(schema([customers]));

    expect(output).toContain('-- People who have registered an account.');
    expect(output).toContain(
      '  email character varying(255) NOT NULL, -- Login address.',
    );
  });

  it('omits comments when asked', () => {
    const output = service.serialize(schema([customers]), {
      includeComments: false,
    });

    expect(output).not.toContain('--');
  });

  it('omits column defaults unless requested', () => {
    expect(service.serialize(schema([customers]))).not.toContain('nextval');

    expect(
      service.serialize(schema([customers]), { includeDefaults: true }),
    ).toContain("DEFAULT nextval('customers_id_seq'::regclass)");
  });

  it('drops the schema prefix when only one schema is in play', () => {
    const output = service.serialize(schema([orders]));

    expect(output).toContain('CREATE TABLE orders (');
    expect(output).toContain('REFERENCES customers (id)');
    expect(output).not.toContain('public.');
  });

  it('qualifies names when more than one schema is exposed', () => {
    const output = service.serialize(schema([orders], ['public', 'analytics']));

    expect(output).toContain('CREATE TABLE public.orders (');
    expect(output).toContain('REFERENCES public.customers (id)');
  });

  it('renders views as CREATE VIEW without constraints', () => {
    const output = service.serialize(schema([activeCustomers]));

    expect(output).toContain('CREATE VIEW active_customers (');
    expect(output).not.toContain('PRIMARY KEY');
  });

  it('restricts output to the requested tables', () => {
    const output = service.serialize(schema([customers, orders]), {
      tables: ['orders'],
    });

    expect(output).toContain('CREATE TABLE orders (');
    expect(output).not.toContain('CREATE TABLE customers (');
  });

  it('separates tables with a blank line', () => {
    const output = service.serialize(schema([customers, orders]));

    expect(output).toContain(');\n\n');
  });

  it('returns an empty string for a schema with no tables', () => {
    expect(service.serialize(schema([]))).toBe('');
  });
});
