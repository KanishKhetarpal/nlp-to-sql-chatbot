-- Sample retail dataset for local development.
--
-- Postgres runs everything in /docker-entrypoint-initdb.d exactly once, when
-- the data volume is first created. Re-run it with:
--   docker compose down -v && docker compose up -d --wait
--
-- The shape here is deliberately ordinary — customers, products, orders and
-- line items — because it gives the introspection and NL-to-SQL layers real
-- foreign keys, enums, numerics and dates to reason about.

CREATE TABLE customers (
    id          SERIAL PRIMARY KEY,
    first_name  VARCHAR(100)  NOT NULL,
    last_name   VARCHAR(100)  NOT NULL,
    email       VARCHAR(255)  NOT NULL UNIQUE,
    city        VARCHAR(100),
    country     VARCHAR(100),
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE customers IS 'People who have registered an account.';
COMMENT ON COLUMN customers.email IS 'Login address; unique across all customers.';
COMMENT ON COLUMN customers.country IS 'ISO country name, not code.';

CREATE TABLE products (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(200)   NOT NULL,
    category        VARCHAR(100)   NOT NULL,
    price           NUMERIC(10, 2) NOT NULL,
    stock_quantity  INTEGER        NOT NULL DEFAULT 0,
    discontinued    BOOLEAN        NOT NULL DEFAULT false
);

COMMENT ON TABLE products IS 'Items available for sale.';
COMMENT ON COLUMN products.price IS 'Unit price in USD.';
COMMENT ON COLUMN products.stock_quantity IS 'Units currently on hand.';

CREATE TABLE orders (
    id            SERIAL PRIMARY KEY,
    customer_id   INTEGER        NOT NULL REFERENCES customers (id),
    status        VARCHAR(20)    NOT NULL DEFAULT 'pending',
    total_amount  NUMERIC(12, 2) NOT NULL DEFAULT 0,
    ordered_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
    shipped_at    TIMESTAMPTZ
);

COMMENT ON TABLE orders IS 'A customer purchase; line items live in order_items.';
COMMENT ON COLUMN orders.status IS 'One of: pending, paid, shipped, delivered, cancelled.';
COMMENT ON COLUMN orders.total_amount IS 'Order total in USD, including all line items.';

CREATE TABLE order_items (
    id          SERIAL PRIMARY KEY,
    order_id    INTEGER        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    product_id  INTEGER        NOT NULL REFERENCES products (id),
    quantity    INTEGER        NOT NULL,
    unit_price  NUMERIC(10, 2) NOT NULL
);

COMMENT ON TABLE order_items IS 'Individual product lines belonging to an order.';
COMMENT ON COLUMN order_items.unit_price IS 'Price per unit at time of purchase, which may differ from products.price.';

CREATE INDEX idx_orders_customer_id ON orders (customer_id);
CREATE INDEX idx_order_items_order_id ON order_items (order_id);

INSERT INTO customers (first_name, last_name, email, city, country) VALUES
    ('Ada',    'Lovelace',  'ada@example.com',    'London',    'United Kingdom'),
    ('Grace',  'Hopper',    'grace@example.com',  'New York',  'United States'),
    ('Alan',   'Turing',    'alan@example.com',   'Manchester','United Kingdom'),
    ('Katherine', 'Johnson','katherine@example.com','Hampton', 'United States'),
    ('Radia',  'Perlman',   'radia@example.com',  'Seattle',   'United States');

INSERT INTO products (name, category, price, stock_quantity) VALUES
    ('Mechanical Keyboard', 'Peripherals', 129.99, 42),
    ('27" Monitor',         'Displays',    329.50, 18),
    ('USB-C Dock',          'Peripherals',  89.00, 75),
    ('Ergonomic Mouse',     'Peripherals',  59.95, 120),
    ('Laptop Stand',        'Accessories',  34.00, 200),
    ('Noise-Cancelling Headphones', 'Audio', 249.00, 30);

INSERT INTO orders (customer_id, status, total_amount, ordered_at, shipped_at) VALUES
    (1, 'delivered', 219.94, now() - INTERVAL '30 days', now() - INTERVAL '28 days'),
    (2, 'shipped',   329.50, now() - INTERVAL '10 days', now() - INTERVAL '8 days'),
    (1, 'paid',      249.00, now() - INTERVAL '5 days',  NULL),
    (3, 'pending',    93.95, now() - INTERVAL '1 day',   NULL),
    (4, 'cancelled', 129.99, now() - INTERVAL '20 days', NULL);

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
    (1, 1, 1, 129.99),
    (1, 4, 1,  59.95),
    (1, 5, 1,  34.00),
    (2, 2, 1, 329.50),
    (3, 6, 1, 249.00),
    (4, 4, 1,  59.95),
    (4, 5, 1,  34.00),
    (5, 1, 1, 129.99);
