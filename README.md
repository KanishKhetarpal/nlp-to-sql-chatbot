# NLP-to-SQL Chatbot

A NestJS service that takes natural-language questions, turns them into safe,
validated SQL against a configured database, executes them, and returns the
results in a chat-style interface.

The goal is not just "ask a question, get a query" — it is to do that without
handing an LLM unchecked access to a database. Generated SQL is parsed and
validated before it runs, execution is restricted to read-only queries under a
row limit and timeout, and every query is logged.

> **Status:** in active development against a 7-day plan — see
> [`MILESTONES.md`](MILESTONES.md). Days 1–4 are complete: project foundations,
> schema introspection, natural-language-to-SQL generation, and query safety.

## How it works

```
question ──▶ schema introspection ──▶ prompt assembly ──▶ LLM
                                                           │
                                                           ▼
results ◀── execution (read-only) ◀── validation ◀───── SQL
```

1. **Introspect** — read table and column metadata from the connected database.
2. **Prompt** — serialize that schema into context for the model.
3. **Generate** — the LLM proposes SQL for the user's question.
4. **Validate** — parse the SQL, reject anything that is not a bounded `SELECT`.
5. **Execute** — run it on a read-only connection with a timeout and row cap.
6. **Respond** — return the rows plus a natural-language summary.

Steps 1–4 are built. Steps 5–6 land on Day 5. Until then the service proposes a
query, judges whether it is safe, and stops — nothing is executed.

### Schema context

Introspection reads the Postgres system catalogs directly, so the snapshot
carries exact declared types, nullability, primary and foreign keys, and the
table and column comments that tell a model what a field actually means. It is
then rendered as DDL — the representation a model has most often seen for this
task, and a cheaper one in tokens than the equivalent JSON:

```sql
-- A customer purchase; line items live in order_items.
CREATE TABLE orders (
  id integer NOT NULL,
  customer_id integer NOT NULL,
  status character varying(20) NOT NULL, -- One of: pending, paid, shipped, delivered, cancelled.
  total_amount numeric(12,2) NOT NULL, -- Order total in USD, including all line items.
  ordered_at timestamp with time zone NOT NULL,
  shipped_at timestamp with time zone,
  PRIMARY KEY (id),
  FOREIGN KEY (customer_id) REFERENCES customers (id)
);
```

Snapshots are cached in memory for `INTROSPECTION_CACHE_TTL` seconds, and
concurrent misses collapse into a single introspection rather than each firing
its own catalog queries.

### Generation

The instructions and the schema form a stable prompt prefix; the question and
the conversation so far follow it, which is the order prompt caching rewards.
The model answers against a JSON schema rather than in prose:

```json
{
  "answerable": true,
  "sql": "SELECT count(*) FROM customers WHERE country = 'United Kingdom';",
  "explanation": "Counts customer rows filtered to the UK.",
  "tables": ["customers"]
}
```

`answerable` is a first-class field, not an empty `sql` by convention. A
question the schema cannot answer should come back as a clear no with the
reason — a plausible query over the wrong columns is worse than no query at all.

### Safety

Nothing the model returns is trusted. Every proposed query is parsed and
inspected before it could ever run, and the result is reported alongside the
generation rather than thrown away:

```json
{
  "status": "valid",
  "sql": "SELECT id, country FROM \"customers\" WHERE country = 'United Kingdom' LIMIT 500",
  "tables": ["customers"],
  "rowLimit": 500,
  "limitOrigin": "injected"
}
```

Checks run against a parsed syntax tree, not regular expressions over the text.
That matters because the interesting attacks are invisible to a text matcher or
a statement-type check:

| Attempt | Why a naive check misses it |
| ------- | --------------------------- |
| `SELECT 1; DROP TABLE customers;` | Only the first statement is inspected |
| `SELECT * INTO evil FROM customers` | Parses as an ordinary `select`, but creates a table |
| `WITH d AS (DELETE FROM customers RETURNING *) SELECT * FROM d` | Opens with `WITH`, deletes rows |
| `SELECT pg_read_file('/etc/passwd')` | Reads the filesystem, references no table at all |
| `EXPLAIN ANALYZE SELECT ...` | Sounds read-only; actually runs the query |

Writes are refused at any depth, tables must appear in the introspected schema
(with optional allow and deny lists on top), and a row cap is applied by
rewriting the query rather than by trusting the model to add a `LIMIT`. A set
operation is wrapped instead of given a `LIMIT` directly, because attaching one
binds it to the first branch and leaves the rest of a `UNION` unbounded.

The statement that comes back is rebuilt from the tree that was checked, so
what would execute is what was validated — not the original text.

A rejection carries every violation found, so the caller can explain all of
what is wrong at once:

```json
{
  "error": "sql_validation_failed",
  "message": "Query rejected: Table \"pg_shadow\" is not in the introspected schema",
  "violations": [
    { "code": "unknown_table", "message": "...", "subject": "pg_shadow" }
  ]
}
```

### Provider independence

Callers depend on an `LlmClient` abstraction, never on a vendor SDK. Two
implementations ship:

| `LLM_PROVIDER` | Behaviour |
| -------------- | --------------------------------------------------------- |
| `stub`         | Default. A canned, deterministic answer — no credentials needed, so the service runs and the whole pipeline can be exercised on a fresh clone. |
| `anthropic`    | Real generation via Claude. Requires `ANTHROPIC_API_KEY`; the app refuses to boot without one. |

Refusals, truncated responses, and transport failures are translated into typed
errors at that boundary, so nothing above it imports the vendor's exception
classes.

### Conversations

Follow-ups ("and how many of those are in the UK?") are resolved against the
turns before them. Conversations live in memory — cheap to rebuild, worthless
once the person leaves — bounded three ways: a TTL, a cap on turns kept per
conversation, and least-recently-active eviction at a session ceiling.

## Tech stack

| Concern       | Choice                        |
| ------------- | ----------------------------- |
| Framework     | NestJS 11 (TypeScript)        |
| Database      | PostgreSQL 16 via TypeORM     |
| Config        | `@nestjs/config` + Joi schema |
| Health checks | `@nestjs/terminus`            |
| Local infra   | Docker Compose                |
| Tests         | Jest + Supertest              |

## Getting started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose

### Setup

```bash
git clone https://github.com/KanishKhetarpal/nlp-to-sql-chatbot.git
cd nlp-to-sql-chatbot
npm install
```

Create your environment file from the template:

```bash
cp .env.example .env
```

Start Postgres. The `--wait` flag returns only once the database is accepting
connections:

```bash
docker compose up -d --wait
```

On first start the container seeds itself from
[`db/init/`](db/init/01-sample-schema.sql) with a small retail dataset —
customers, products, orders and order items — so there is a real schema to
introspect and ask questions about. Postgres only runs those scripts when the
data volume is empty, so to re-seed after changing them:

```bash
docker compose down -v && docker compose up -d --wait
```

Run the app:

```bash
npm run start:dev
```

The service listens on `http://localhost:3000`.

### Verify

```bash
curl http://localhost:3000/health
```

A healthy service returns `200`:

```json
{
  "status": "ok",
  "info": { "database": { "status": "up" } },
  "error": {},
  "details": { "database": { "status": "up" } }
}
```

If Postgres is unreachable the same endpoint returns `503` with the database
marked `down`, so the check is a genuine readiness signal rather than a
liveness stub.

Then look at what the service can see of your database:

```bash
curl http://localhost:3000/schema/prompt
```

## API

| Endpoint               | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `GET /health`          | Liveness plus a database ping; `503` when Postgres is down |
| `GET /schema`          | Full metadata snapshot as JSON, with cache status       |
| `GET /schema/prompt`   | The same snapshot as prompt-ready DDL (`text/plain`)    |
| `POST /schema/refresh` | Drop the cached snapshot and re-read the catalogs       |

Both schema reads accept `?refresh=true` to bypass the cache for a single
call. `GET /schema/prompt` additionally takes:

| Parameter   | Default | Description                                     |
| ----------- | ------- | ----------------------------------------------- |
| `tables`    | all     | Comma-separated list to narrow the output        |
| `comments`  | `true`  | Include table and column comments                |
| `defaults`  | `false` | Include column defaults                          |

```bash
curl "http://localhost:3000/schema/prompt?tables=orders,customers&defaults=true"
```

## Configuration

All variables are validated at boot against a Joi schema
([`src/config/env.validation.ts`](src/config/env.validation.ts)). A missing or
malformed value fails startup immediately instead of surfacing later as a
runtime error.

| Variable         | Default       | Description                                 |
| ---------------- | ------------- | ------------------------------------------- |
| `NODE_ENV`       | `development` | `development` \| `test` \| `production`     |
| `PORT`           | `3000`        | HTTP port the service listens on            |
| `DB_HOST`        | —             | Postgres host (required)                    |
| `DB_PORT`        | `5432`        | Postgres port — `5433` in the compose setup |
| `DB_USERNAME`    | —             | Postgres user (required)                    |
| `DB_PASSWORD`    | —             | Postgres password (required, may be empty)  |
| `DB_NAME`        | —             | Database name (required)                    |
| `DB_SYNCHRONIZE` | `false`       | TypeORM auto-sync — local development only  |
| `DB_LOGGING`     | `false`       | Log generated SQL                           |

Schema introspection:

| Variable                  | Default  | Description                                          |
| ------------------------- | -------- | ---------------------------------------------------- |
| `INTROSPECTION_SCHEMAS`   | `public` | Comma-separated Postgres schemas to expose            |
| `INTROSPECTION_CACHE_TTL` | `300`    | Seconds a snapshot stays fresh; `0` disables caching  |

Language model:

| Variable            | Default          | Description                                              |
| ------------------- | ---------------- | -------------------------------------------------------- |
| `LLM_PROVIDER`      | `stub`           | `stub` \| `anthropic`                                     |
| `ANTHROPIC_API_KEY` | —                | Required when `LLM_PROVIDER=anthropic`                    |
| `LLM_MODEL`         | `claude-opus-5`  | Model id                                                  |
| `LLM_MAX_TOKENS`    | `16000`          | Output ceiling — covers reasoning and answer together     |
| `LLM_EFFORT`        | `high`           | `low` … `max`; worth sweeping down on your own examples   |

Conversations:

| Variable                    | Default | Description                                   |
| --------------------------- | ------- | --------------------------------------------- |
| `CONVERSATION_TTL`          | `3600`  | Seconds a conversation survives without use    |
| `CONVERSATION_MAX_TURNS`    | `20`    | Turns kept per conversation                    |
| `CONVERSATION_MAX_SESSIONS` | `1000`  | Conversations held before LRU eviction         |

Query safety:

| Variable              | Default | Description                                          |
| --------------------- | ------- | ---------------------------------------------------- |
| `SQL_MAX_ROWS`        | `500`   | Hard row ceiling, applied by rewriting the query      |
| `SQL_ALLOWED_TABLES`  | —       | Comma-separated; empty means every introspected table |
| `SQL_DENIED_TABLES`   | —       | Comma-separated; checked before the allow list        |

## Project structure

```
db/init/          # SQL seeded into Postgres on first container start
src/
├── config/       # environment loading, Joi validation, typed config
├── database/     # TypeORM connection module
├── health/       # GET /health — liveness + database ping
├── schema/       # catalog introspection, TTL cache, DDL serialization
├── llm/          # provider-agnostic client + Anthropic and stub backends
├── nl-to-sql/    # prompt construction, conversations, SQL generation
├── sql-safety/   # parser-based validation, table rules, row limits
└── main.ts       # bootstrap
```

The chat endpoints that expose generation over HTTP arrive on Day 6; for now
`SqlGenerationService` is consumed in-process.

## Scripts

```bash
npm run start:dev    # watch mode
npm run build        # compile to dist/
npm run lint         # eslint --fix
npm test             # unit tests
npm run test:e2e     # end-to-end tests
npm run test:cov     # coverage report
```

## Roadmap

The full 7-day breakdown is in [`MILESTONES.md`](MILESTONES.md).

- **Day 1** — project foundations ✅
- **Day 2** — schema introspection ✅
- **Day 3** — NL-to-SQL generation ✅
- **Day 4** — SQL validation and safety ✅
- **Day 5** — query execution and results
- **Day 6** — chat API and access control
- **Day 7** — polish, docs, deployment

## License

UNLICENSED — portfolio project.
