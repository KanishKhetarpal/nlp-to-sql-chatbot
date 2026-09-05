import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: TypeOrmHealthIndicator,
  ) {}

  /**
   * Liveness plus dependency check. Returns 200 only when the process is up
   * and the database answers a ping, so a container orchestrator can tell the
   * difference between "running" and "actually able to serve traffic".
   *
   * Exempt from rate limiting. Probes share an address with real traffic, so
   * a throttled probe would answer 429, the orchestrator would read that as
   * unhealthy, and a service that was merely busy would be restarted — load
   * causing an outage rather than revealing one.
   */
  @Get()
  @Public()
  @SkipThrottle()
  @HealthCheck()
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.database.pingCheck('database', { timeout: 3000 }),
    ]);
  }
}
