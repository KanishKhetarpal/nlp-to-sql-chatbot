# Roadmap

A NestJS service that takes natural-language questions, turns them into safe,
validated SQL against a configured database, executes them, and returns
results in a chat-style interface.

## Day 1 — Project foundations
- Scaffold NestJS project structure
- Environment configuration module with validation
- Database connection module (TypeORM + Postgres)
- Health check endpoint
- Local development setup (Docker Compose for Postgres)
- Project documentation

## Day 2 — Schema introspection
- Service to read table/column metadata from the connected database
- Cache introspected schema
- Endpoint to inspect the current schema
- Schema-to-prompt serialization for later LLM use
- Unit tests for introspection service

## Day 3 — NL to SQL generation
- LLM client wrapper (provider-agnostic interface)
- Prompt construction using schema context
- SQL generation service
- Basic conversation/session handling
- Unit tests for prompt construction

## Day 4 — SQL validation & safety
- SQL parser/validator (block writes, restrict to SELECT)
- Query allowlist/denylist rules (tables, row limits)
- Guard against destructive statements
- Validation error responses
- Tests covering malicious/invalid query attempts

## Day 5 — Query execution & results
- Safe query execution against read-only connection
- Result formatting (tabular + natural-language summary)
- Query timeout and row-limit enforcement
- Execution logging/audit trail
- Integration tests for execution pipeline

## Day 6 — Chat API & access control
- REST endpoints for chat sessions (create, ask, history)
- Request validation (DTOs, pipes)
- Basic API key auth guard
- Rate limiting
- E2E tests for the chat flow

## Day 7 — Polish, docs, deployment
- Swagger/OpenAPI documentation
- Error handling and global exception filter
- README with setup/usage instructions
- Dockerfile for the app itself
- Final pass: lint, test coverage, cleanup
