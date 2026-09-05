import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  CLIENT_ID_PROPERTY,
  ClientIdentifiedRequest,
} from '../decorators/client-id.decorator';

/**
 * Rate limits per API key rather than per IP address.
 *
 * The stock guard tracks `req.ip`, which is the wrong unit of fairness here
 * for two reasons. Several keys issued to several callers routinely share an
 * egress address, so one of them could spend everyone's budget. And behind a
 * load balancer — which is how this would actually be deployed — Express
 * reports the proxy's address unless `trust proxy` is set, so *every* caller
 * collapses into a single bucket and the whole service gets one client's
 * allowance.
 *
 * Keying on the authenticated caller sidesteps both: it is the identity the
 * budget is meant to belong to, and it does not depend on the network path
 * the request took to arrive.
 *
 * The IP remains the fallback for unauthenticated traffic — open mode, where
 * no keys are configured — because something has to bound it.
 */
@Injectable()
export class ClientThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: ClientIdentifiedRequest): Promise<string> {
    const clientId = req[CLIENT_ID_PROPERTY];

    return Promise.resolve(clientId ?? req.ip ?? 'unknown');
  }
}
