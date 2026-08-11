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

export interface Configuration {
  app: AppConfig;
  database: DatabaseConfig;
}

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
});
