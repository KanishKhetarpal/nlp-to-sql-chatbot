import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

/** Where the guard leaves the identity of the key that authenticated. */
export const CLIENT_ID_PROPERTY = 'clientId';

export interface ClientIdentifiedRequest extends Request {
  [CLIENT_ID_PROPERTY]?: string;
}

/**
 * The caller's identity, derived from the API key they presented.
 *
 * `undefined` when no keys are configured, which is the open mode a fresh
 * clone runs in: there is one implicit caller, so there is nothing to tell
 * apart and everything stays visible to everyone.
 */
export const ClientId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<ClientIdentifiedRequest>()[
      CLIENT_ID_PROPERTY
    ],
);
