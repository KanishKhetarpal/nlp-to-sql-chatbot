import {
  HealthCheckResult,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { HealthController } from './health.controller';

/**
 * The endpoint a container orchestrator polls. What matters is not that it
 * returns 200 — it is that it only does so when the database answers, and
 * that it gives up rather than hanging when the database does not.
 */
describe('HealthController', () => {
  let controller: HealthController;
  let check: jest.Mock;
  let pingCheck: jest.Mock;

  const healthy: HealthCheckResult = {
    status: 'ok',
    info: { database: { status: 'up' } },
    error: {},
    details: { database: { status: 'up' } },
  };

  /** The indicators the controller handed to terminus. */
  const indicators = (): (() => unknown)[] =>
    (check.mock.calls as unknown as [(() => unknown)[]][])[0][0];

  beforeEach(() => {
    check = jest.fn().mockResolvedValue(healthy);
    pingCheck = jest.fn().mockResolvedValue({ database: { status: 'up' } });

    controller = new HealthController(
      { check } as unknown as HealthCheckService,
      { pingCheck } as unknown as TypeOrmHealthIndicator,
    );
  });

  it('reports what the check found', async () => {
    await expect(controller.check()).resolves.toEqual(healthy);
  });

  it('checks the database, not just the process', async () => {
    // A liveness probe that only proves the event loop is turning would keep
    // a container in the load balancer while every query fails.
    await controller.check();

    expect(check).toHaveBeenCalledTimes(1);
    expect(indicators()).toHaveLength(1);

    await indicators()[0]();
    expect(pingCheck).toHaveBeenCalledWith('database', { timeout: 3000 });
  });

  it('bounds the ping, so an unreachable database fails rather than hangs', async () => {
    await controller.check();
    await indicators()[0]();

    const calls = pingCheck.mock.calls as unknown as [
      string,
      { timeout: number },
    ][];
    expect(calls[0][1].timeout).toBeGreaterThan(0);
  });

  it('propagates a failure instead of reporting healthy', async () => {
    check.mockRejectedValue(new Error('database is down'));

    await expect(controller.check()).rejects.toThrow('database is down');
  });
});
