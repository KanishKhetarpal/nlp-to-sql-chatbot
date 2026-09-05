export interface AppConfig {
  nodeEnv: string;
  port: number;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  name: string;
  synchronize: boolean;
  logging: boolean;
}

export interface IntrospectionConfig {
  /** Postgres namespaces to read metadata from. */
  schemas: string[];
  /** How long an introspected snapshot stays fresh, in seconds. */
  cacheTtlSeconds: number;
}

export type LlmProvider = 'anthropic' | 'stub';

export interface LlmConfig {
  /** Which backend fulfils completions. `stub` needs no credentials. */
  provider: LlmProvider;
  apiKey: string;
  model: string;
  maxTokens: number;
  /** Thinking depth and overall token spend. */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** How long one attempt may take before it is abandoned. */
  timeoutMs: number;
  /** Attempts the SDK makes after the first, on a retryable failure. */
  maxRetries: number;
}

export interface ConversationConfig {
  /** How long a conversation survives without activity, in seconds. */
  ttlSeconds: number;
  /** Turns kept per conversation; older turns fall out of the prompt. */
  maxTurns: number;
  /** Conversations held in memory before the least recent are evicted. */
  maxSessions: number;
}

export interface SqlSafetyConfig {
  /** Hard ceiling on rows any generated query may return. */
  maxRows: number;
  /** When non-empty, only these tables may be queried. */
  allowedTables: string[];
  /** Tables that may never be queried, checked before the allow list. */
  deniedTables: string[];
}

export interface ExecutionConfig {
  /** Statement timeout applied to every query, in milliseconds. */
  timeoutMs: number;
  /** Audit entries kept in memory for inspection. */
  auditHistory: number;
}

export interface ApiConfig {
  /** Accepted x-api-key values. Empty leaves every route open. */
  keys: string[];
  /** Requests allowed per window, per client. */
  rateLimit: number;
  /** Rate-limit window in seconds. */
  rateWindowSeconds: number;
}

export interface Configuration {
  app: AppConfig;
  database: DatabaseConfig;
  introspection: IntrospectionConfig;
  llm: LlmConfig;
  conversation: ConversationConfig;
  sqlSafety: SqlSafetyConfig;
  execution: ExecutionConfig;
  api: ApiConfig;
}

const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);

/**
 * Maps validated environment variables onto a typed, namespaced config object.
 * Every consumer reads config through this shape rather than touching
 * process.env directly.
 */
export default (): Configuration => ({
  app: {
    nodeEnv: process.env.NODE_ENV as string,
    port: parseInt(process.env.PORT as string, 10),
  },
  database: {
    host: process.env.DB_HOST as string,
    port: parseInt(process.env.DB_PORT as string, 10),
    username: process.env.DB_USERNAME as string,
    password: process.env.DB_PASSWORD as string,
    name: process.env.DB_NAME as string,
    synchronize: process.env.DB_SYNCHRONIZE === 'true',
    logging: process.env.DB_LOGGING === 'true',
  },
  introspection: {
    schemas: (process.env.INTROSPECTION_SCHEMAS as string)
      .split(',')
      .map((schema) => schema.trim())
      .filter((schema) => schema.length > 0),
    cacheTtlSeconds: parseInt(
      process.env.INTROSPECTION_CACHE_TTL as string,
      10,
    ),
  },
  llm: {
    provider: process.env.LLM_PROVIDER as LlmProvider,
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.LLM_MODEL as string,
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS as string, 10),
    effort: process.env.LLM_EFFORT as LlmConfig['effort'],
    timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS as string, 10),
    maxRetries: parseInt(process.env.LLM_MAX_RETRIES as string, 10),
  },
  conversation: {
    ttlSeconds: parseInt(process.env.CONVERSATION_TTL as string, 10),
    maxTurns: parseInt(process.env.CONVERSATION_MAX_TURNS as string, 10),
    maxSessions: parseInt(process.env.CONVERSATION_MAX_SESSIONS as string, 10),
  },
  sqlSafety: {
    maxRows: parseInt(process.env.SQL_MAX_ROWS as string, 10),
    allowedTables: csv(process.env.SQL_ALLOWED_TABLES),
    deniedTables: csv(process.env.SQL_DENIED_TABLES),
  },
  execution: {
    timeoutMs: parseInt(process.env.EXECUTION_TIMEOUT_MS as string, 10),
    auditHistory: parseInt(process.env.AUDIT_HISTORY as string, 10),
  },
  api: {
    // Keys are case-sensitive secrets, so this list is not lower-cased the way
    // the table names are.
    keys: (process.env.API_KEYS ?? '')
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0),
    rateLimit: parseInt(process.env.RATE_LIMIT as string, 10),
    rateWindowSeconds: parseInt(process.env.RATE_LIMIT_WINDOW as string, 10),
  },
});
