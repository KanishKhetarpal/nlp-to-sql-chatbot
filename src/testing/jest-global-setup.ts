import { databaseAvailable, requireDatabaseInCi } from './database-probe';

/**
 * Probes for a database once, before any suite is loaded, and publishes the
 * answer so specs can decide at declaration time whether to register their
 * tests or skip them.
 *
 * Deciding inside the test body instead would report a no-op as a *pass* —
 * "9 passed" for nine tests that asserted nothing. Jest cannot mark a test
 * pending once it is running, so the choice has to be made before the file
 * is evaluated, which is what a global setup is for.
 *
 * The CI check lives here too, so it is stated once and cannot be bypassed by
 * a suite that skips its own `beforeAll`.
 */
const globalSetup = async (): Promise<void> => {
  const available = await databaseAvailable();

  requireDatabaseInCi(available, 'the database-backed suites');

  process.env.DATABASE_AVAILABLE = String(available);
};

export default globalSetup;
