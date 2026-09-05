# NLP-to-SQL Chatbot

[![CI](https://github.com/KanishKhetarpal/nlp-to-sql-chatbot/actions/workflows/ci.yml/badge.svg)](https://github.com/KanishKhetarpal/nlp-to-sql-chatbot/actions/workflows/ci.yml)

A NestJS service that takes natural-language questions, turns them into safe,
validated SQL against a configured database, executes them, and returns the
results in a chat-style interface.

The goal is not just "ask a question, get a query" — it is to do that without
handing an LLM unchecked access to a database. Generated SQL is parsed and
validated before it runs, execution is restricted to read-only queries under a
row limit and timeout, and every query is logged.

> **Status:** complete against the 7-day plan in [`MILESTONES.md`](MILESTONES.md).

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

All six steps are built and reachable over HTTP.

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
rewriting the query rather than by trusting the model to add a `LIMIT`. An
`OFFSET` is read as an offset rather than mistaken for a bound, and is kept
when the cap is applied — otherwise a request for a later page comes back as
the first one. A set
operation is wrapped instead of given a `LIMIT` directly, because attaching one
binds it to the first branch and leaves the rest of a `UNION` unbounded.

The statement that comes back is rebuilt from the tree that was checked, so
what would execute is what was validated — not the original text.

The allow and deny lists are applied twice, in two different senses. A denied
table is **hidden**: it is filtered out of the schema before anything is
serialized, so it never appears in a prompt, is never sent to the model
provider, and is not served by `GET /schema`. Foreign keys pointing at it are
dropped with it, since `REFERENCES <hidden table>` would name it anyway. Safety
review then rejects it independently, as a second gate on what actually runs.

That matters for what a deny list means: hiding the table stops its column
names and comments leaving the building at all, and stops the model proposing
a query that was only ever going to be refused.

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

### Execution

A query that passes review runs inside a transaction that is explicitly marked
read-only and given a statement timeout:

```sql
SET LOCAL transaction_read_only = on;
SET LOCAL statement_timeout = 10000;
```

That is the second lock on the same door. Validation has already refused
anything that writes, so this is what catches a write that reaches execution
through a parser gap or a future bug — the database refuses it rather than
trusting the check upstream was perfect. `SET LOCAL` scopes both settings to
the transaction, so neither leaks onto the next borrower of a pooled
connection. The transaction is rolled back rather than committed, since a read
has nothing to commit.

Results are summarized deterministically, not by a second model call:

```
count: 5
2 rows, 2 columns (id, country).
No rows matched.
```

Every query is audited — including the ones refused before reaching the
database, and dry runs that never execute. The trail is written to the log and
kept in a bounded ring readable at `GET /chat/audit`. It is deliberately not
written to the target database, which is read-only by design and belongs to
someone else.

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

Interactive documentation is served at `http://localhost:3000/docs`.

| Endpoint                     | Description                                             |
| ---------------------------- | ------------------------------------------------------- |
| `POST /chat/ask`             | Ask a question; returns the SQL, the rows and a summary  |
| `POST /chat/sessions`        | Start a conversation                                     |
| `GET /chat/sessions/:id`     | The turns so far                                         |
| `DELETE /chat/sessions/:id`  | Discard a conversation                                   |
| `GET /chat/audit`            | Recent queries, newest first                             |
| `GET /health`                | Liveness plus a database ping; `503` when Postgres is down |
| `GET /schema`                | Full metadata snapshot as JSON, with cache status         |
| `GET /schema/prompt`         | The same snapshot as prompt-ready DDL (`text/plain`)      |
| `POST /schema/refresh`       | Drop the cached snapshot and re-read the catalogs         |

### Asking a question

```bash
curl -X POST http://localhost:3000/chat/ask \
  -H 'Content-Type: application/json' \
  -d '{"question": "How many customers are in the United Kingdom?"}'
```

```json
{
  "status": "answered",
  "conversationId": "d6a252cb-4d21-41c5-b189-b106cce6c32a",
  "sql": "SELECT count(*) FROM customers WHERE country = 'United Kingdom' LIMIT 500",
  "summary": "count: 2",
  "result": { "columns": ["count"], "rows": [{ "count": 2 }], "rowCount": 1 },
  "model": "claude-opus-5"
}
```

`status` is the field to read. `answered` means rows came back; `unanswerable`
means the schema cannot answer it; `rejected` means the generated query failed
safety review and `violations` says why; `failed` means the database refused or
timed out; `dry_run` means it stopped before executing. All of them return
`200` — they are answers, not transport failures.

Pass `conversationId` to continue a conversation, or `dryRun: true` to see the
query without running it.

### Access control

With `API_KEYS` set, every route except `/health` requires a matching
`x-api-key` header:

```bash
curl -X POST http://localhost:3000/chat/ask \
  -H 'x-api-key: your-key' \
  -H 'Content-Type: application/json' \
  -d '{"question": "How many orders shipped last month?"}'
```

Leaving `API_KEYS` empty leaves the API open, which is convenient locally and
must not be how it ships — the service warns about it at boot. Requests are
also rate limited (`RATE_LIMIT` per `RATE_LIMIT_WINDOW` seconds), counted
against the key that presented them rather than the address they came from —
several keys behind one office IP, or one load balancer, each get their own
allowance. Unauthenticated traffic falls back to the address, and `/health`
is exempt: a throttled probe reads as unhealthy, so load would restart a
service that was only busy.

Several keys mean several callers, and they are kept apart. A conversation
belongs to the key that started it, and `GET /chat/audit` returns that key's
own queries rather than everyone's — the trail names tables, columns and
often values lifted straight from the question. Another caller's conversation
answers `404`, not `403`: "it exists, but it is not yours" is itself
something the caller did not know.

The identifier behind that scoping is a hash of the key, so it can appear in
logs and audit entries without the key itself doing so. With `API_KEYS` empty
there is one implicit caller and nothing to separate.

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
| `LLM_TIMEOUT_MS`    | `60000`          | One attempt; unset, the SDK allows ten minutes            |
| `LLM_MAX_RETRIES`   | `2`              | Retries multiply the timeout — worst case is 3 × the above |

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
| `SQL_DENIED_TABLES`   | —       | Comma-separated; hidden from prompts, and refused if named |

Execution and API:

| Variable               | Default | Description                                   |
| ---------------------- | ------- | --------------------------------------------- |
| `EXECUTION_TIMEOUT_MS` | `10000` | Statement timeout, enforced by Postgres        |
| `AUDIT_HISTORY`        | `200`   | Audit entries kept in memory                   |
| `API_KEYS`             | —       | Comma-separated; empty leaves the API open     |
| `RATE_LIMIT`           | `30`    | Requests per window, per client                |
| `RATE_LIMIT_WINDOW`    | `60`    | Window length in seconds                       |

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
├── execution/    # read-only execution, result formatting, audit trail
├── chat/         # HTTP surface: ask, sessions, audit
├── common/       # guards, decorators, exception filter
└── main.ts       # bootstrap
```



## Scripts

```bash
npm run start:dev    # watch mode
npm run build        # compile to dist/
npm run lint         # eslint --fix
npm run lint:check   # eslint, no fixing — what CI runs
npm run typecheck    # tsc --noEmit
npm test             # unit tests
npm run test:e2e     # end-to-end tests
npm run test:cov     # coverage report
```

## Deployment

The image is multi-stage: dev dependencies compile the app and are then pruned,
so they never reach the runtime layer. It runs as the unprivileged `node` user
and carries a healthcheck that uses the app's own readiness endpoint.

```bash
docker build -t nlp-to-sql-chatbot .
docker run -p 3000:3000 \
  -e DB_HOST=host.docker.internal -e DB_PORT=5433 \
  -e DB_USERNAME=postgres -e DB_PASSWORD=postgres -e DB_NAME=nlp_to_sql \
  nlp-to-sql-chatbot
```

Before putting it in front of anyone else: set `API_KEYS`, point it at a
database role that only has `SELECT` (the read-only transaction is a good
guard, a restricted role is a better one), and set `LLM_PROVIDER=anthropic`
with a key.

## Testing

```bash
npm test           # unit and integration suites
npm run test:e2e   # drives the whole app over HTTP
npm run test:cov   # coverage
```

Tests that need Postgres skip themselves when none is reachable, so a clone
without Docker running still gets an honest green rather than a wall of
connection errors. Start the database to include them. They are reported as
*skipped* rather than passed — the decision is made in a Jest global setup,
before the suites load, because a test that returns early still counts as a
pass and nine passes that asserted nothing is not an honest run.

324 tests across unit, integration and end-to-end suites; roughly 90%
statement coverage. Both figures are the ones CI reports, where the
database-backed suites actually run — measuring locally without Postgres
would quietly leave them out and report a floor.

The integration and e2e suites run against a real database rather than a
mock, because the guarantees that matter most — read-only enforcement,
statement timeouts, and whether the rewritten SQL is even valid — belong to
Postgres, and a mock would only assert that the code agrees with itself.

### Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to
`main` and every pull request: lint, typecheck, build, then both test suites
against a Postgres service container seeded from `db/init`.

Two details are deliberate. The lint step runs `lint:check` rather than `lint`,
because the latter passes `--fix` and would report success on code that never
satisfied the rules. And a database that is unreachable *fails* the run instead
of skipping, since the whole point of the pipeline is to vouch for tests that
actually executed — locally the same absence is still just a skip.

Generation runs against the stub provider, so no API key is needed; every other
layer is exercised for real.

## Roadmap

The full 7-day breakdown is in [`MILESTONES.md`](MILESTONES.md).

- **Day 1** — project foundations ✅
- **Day 2** — schema introspection ✅
- **Day 3** — NL-to-SQL generation ✅
- **Day 4** — SQL validation and safety ✅
- **Day 5** — query execution and results ✅
- **Day 6** — chat API and access control ✅
- **Day 7** — polish, docs, deployment ✅

Since then, outside the plan: continuous integration on every push, and
coverage for the pipeline's refusal and failure paths — the branches the
end-to-end suite cannot reach, because it cannot force a timeout or a
rejection on demand.

## License

UNLICENSED — portfolio project.
