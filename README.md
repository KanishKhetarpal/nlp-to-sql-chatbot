# NLP-to-SQL Chatbot

A NestJS service that takes natural-language questions, turns them into safe,
validated SQL against a configured database, executes them, and returns the
results in a chat-style interface.

The goal is not just "ask a question, get a query" — it is to do that without
handing an LLM unchecked access to a database. Generated SQL is parsed and
validated before it runs, execution is restricted to read-only queries under a
row limit and timeout, and every query is logged.

> **Status:** in active development against a 7-day plan — see
> [`MILESTONES.md`](MILESTONES.md). Day 1 (project foundations) is complete.

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

Steps 1–2 land on Day 2, 3 on Day 3, 4 on Day 4, and 5–6 on Day 5.

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

## Project structure

```
src/
├── config/       # environment loading, Joi validation, typed config
├── database/     # TypeORM connection module
├── health/       # GET /health — liveness + database ping
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
- **Day 2** — schema introspection
- **Day 3** — NL-to-SQL generation
- **Day 4** — SQL validation and safety
- **Day 5** — query execution and results
- **Day 6** — chat API and access control
- **Day 7** — polish, docs, deployment

## License

UNLICENSED — portfolio project.
