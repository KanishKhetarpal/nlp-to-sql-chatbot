import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ApiConfig } from '../../config/configuration';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Checks the `x-api-key` header against the configured keys.
 *
 * With no keys configured the guard stands aside, so a fresh clone runs
 * without ceremony. That default is announced loudly at boot rather than left
 * to be discovered: an unprotected endpoint that talks to a database should
 * never be a quiet default in a deployment.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);
  private readonly keys: string[];

  constructor(
    configService: ConfigService,
    private readonly reflector: Reflector,
  ) {
    this.keys = configService.get<ApiConfig>('api')!.keys;

    if (this.keys.length === 0) {
      this.logger.warn(
        'API_KEYS is empty — every endpoint is open. Set it before deploying.',
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.keys.length === 0) {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const presented = request.header('x-api-key');

    if (!presented || !this.matches(presented)) {
      throw new UnauthorizedException('A valid x-api-key header is required');
    }

    return true;
  }

  /**
   * Compares in constant time.
   *
   * A plain `includes` leaks how much of a guess was right through how long
   * the comparison took, which is exactly the signal a key-guessing attack
   * wants. Lengths are compared first because timingSafeEqual throws on a
   * mismatch, and length alone is not the secret.
   */
  private matches(presented: string): boolean {
    const candidate = Buffer.from(presented);

    return this.keys.some((key) => {
      const known = Buffer.from(key);
      return (
        known.length === candidate.length && timingSafeEqual(known, candidate)
      );
    });
  }
}
