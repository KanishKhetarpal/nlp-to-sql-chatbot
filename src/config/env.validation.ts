import * as Joi from 'joi';

/**
 * Schema every environment variable is checked against on boot. A missing or
 * malformed value fails startup immediately instead of surfacing as a runtime
 * error somewhere deeper in the request path.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),

  DB_HOST: Joi.string().hostname().required(),
  DB_PORT: Joi.number().port().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().allow('').required(),
  DB_NAME: Joi.string().required(),

  // Schema is managed through migrations; synchronize stays off unless a
  // developer deliberately turns it on locally.
  DB_SYNCHRONIZE: Joi.boolean().default(false),
  DB_LOGGING: Joi.boolean().default(false),

  // Comma-separated list of Postgres schemas to introspect.
  INTROSPECTION_SCHEMAS: Joi.string().default('public'),
  INTROSPECTION_CACHE_TTL: Joi.number().integer().min(0).default(300),

  // Which backend answers natural-language questions. `stub` is the default so
  // the service runs with no credentials; `anthropic` requires an API key and
  // is rejected at boot without one.
  LLM_PROVIDER: Joi.string().valid('anthropic', 'stub').default('stub'),
  ANTHROPIC_API_KEY: Joi.string()
    .allow('')
    .default('')
    .when('LLM_PROVIDER', {
      is: 'anthropic',
      then: Joi.string().required().min(1),
    }),
  LLM_MODEL: Joi.string().default('claude-opus-5'),
  LLM_MAX_TOKENS: Joi.number().integer().min(1024).default(16000),
  // `high` is the API default. `medium` and `low` are worth sweeping on your
  // own examples — they are unusually strong on current models and cost less.
  LLM_EFFORT: Joi.string()
    .valid('low', 'medium', 'high', 'xhigh', 'max')
    .default('high'),

  // Conversations are held in memory, so all three of these bound how much of
  // it a busy instance can consume.
  CONVERSATION_TTL: Joi.number().integer().min(60).default(3600),
  CONVERSATION_MAX_TURNS: Joi.number().integer().min(1).default(20),
  CONVERSATION_MAX_SESSIONS: Joi.number().integer().min(1).default(1000),

  // Query safety. The row cap is enforced on every generated query, by
  // rewriting it rather than by trusting the model to include a LIMIT.
  SQL_MAX_ROWS: Joi.number().integer().min(1).max(10000).default(500),
  // Comma-separated. An empty allow list means every introspected table.
  SQL_ALLOWED_TABLES: Joi.string().allow('').default(''),
  SQL_DENIED_TABLES: Joi.string().allow('').default(''),

  // Execution. The timeout is applied by the database itself, so a runaway
  // query is cancelled server-side rather than left to finish unattended.
  EXECUTION_TIMEOUT_MS: Joi.number().integer().min(100).max(120000).default(10000),
  AUDIT_HISTORY: Joi.number().integer().min(1).max(10000).default(200),
});
