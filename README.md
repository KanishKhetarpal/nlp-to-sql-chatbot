# NLP-to-SQL Chatbot

A NestJS service that takes natural-language questions, turns them into safe,
validated SQL against a configured database, executes them, and returns the
results in a chat-style interface.

The goal is not just "ask a question, get a query" — it is to do that without
handing an LLM unchecked access to a database. Generated SQL is parsed and
validated before it runs, execution is restricted to read-only queries under a
row limit and timeout, and every query is logged.

> **Status:** in active development against a 7-day plan — see
> [`MILESTONES.md`](MILESTONES.md). Days 1–2 are complete: project foundations
> and schema introspection.

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

Steps 1 and 2 are built. Step 3 lands on Day 3, 4 on Day 4, and 5–6 on Day 5.

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

## Project structure

```
db/init/          # SQL seeded into Postgres on first container start
src/
├── config/       # environment loading, Joi validation, typed config
├── database/     # TypeORM connection module
├── health/       # GET /health — liveness + database ping
├── schema/       # catalog introspection, TTL cache, DDL serialization
└── main.ts       # bootstrap
```

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
- **Day 3** — NL-to-SQL generation
- **Day 4** — SQL validation and safety
- **Day 5** — query execution and results
- **Day 6** — chat API and access control
- **Day 7** — polish, docs, deployment

## License

UNLICENSED — portfolio project.
