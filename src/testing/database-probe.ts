import { DataSource } from 'typeorm';

/**
 * Whether a Postgres instance matching the current environment is reachable.
 *
 * The suites that need a real database ask this first so a clone without
 * Docker running reports honestly instead of failing to boot. Defaults match
 * `.env.example` and `docker-compose.yml`.
 */
export const databaseAvailable = async (): Promise<boolean> => {
  const probe = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5433', 10),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: process.env.DB_NAME ?? 'nlp_to_sql',
    connectTimeoutMS: 2000,
  });

  try {
    await probe.initialize();
    await probe.destroy();
    return true;
  } catch {
    return false;
  }
};

/**
 * Turns an unreachable database into a hard failure under CI, and a warning
 * everywhere else.
 *
 * Skipping is the right behaviour on a laptop with Docker switched off. It is
 * the wrong behaviour on a build server: the suite would run nothing, report
 * green, and the pipeline would vouch for tests that never executed. Which of
 * those two a run wants is exactly what `CI` distinguishes.
 */
export const requireDatabaseInCi = (
  available: boolean,
  suite: string,
): void => {
  if (available) {
    return;
  }

  const where = `${process.env.DB_HOST ?? 'localhost'}:${process.env.DB_PORT ?? '5433'}`;

  if (process.env.CI) {
    throw new Error(
      `Cannot run ${suite}: no database was reachable at ${where}. ` +
        'Refusing to skip under CI, because a suite that runs nothing must ' +
        'not report success.',
    );
  }

  console.warn(
    `Skipping ${suite}: no database reachable at ${where}. ` +
      'Run `docker compose up -d --wait` to include these tests.',
  );
};
