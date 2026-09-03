import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiConfig } from '../../config/configuration';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  CLIENT_ID_PROPERTY,
  ClientIdentifiedRequest,
} from '../decorators/client-id.decorator';

/**
 * Checks the `x-api-key` header against the configured keys.
 *
 * With no keys configured the guard stands aside, so a fresh clone runs
 * without ceremony. That default is announced loudly at boot rather than left
 * to be discovered: an unprotected endpoint that talks to a database should
 * never be a quiet default in a deployment.
 *
 * When a key does authenticate, the guard records *which* one on the request.
 * Several keys mean several callers, and without that the service could not
 * tell one from another — which is what let any key holder read every other
 * caller's questions out of the audit trail.
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

    const request = context
      .switchToHttp()
      .getRequest<ClientIdentifiedRequest>();
    const presented = request.header('x-api-key');
    const matched = presented ? this.find(presented) : null;

    if (!matched) {
      throw new UnauthorizedException('A valid x-api-key header is required');
    }

    request[CLIENT_ID_PROPERTY] = identify(matched);

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
  private find(presented: string): string | null {
    const candidate = Buffer.from(presented);

    return (
      this.keys.find((key) => {
        const known = Buffer.from(key);
        return (
          known.length === candidate.length && timingSafeEqual(known, candidate)
        );
      }) ?? null
    );
  }
}

/**
 * A stable, non-reversible name for a key.
 *
 * Hashed rather than indexed so it survives a reordering of API_KEYS, and
 * truncated because it only has to tell callers apart — it ends up in logs
 * and in audit entries, where the key itself must never appear.
 */
const identify = (key: string): string =>
  `client-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
