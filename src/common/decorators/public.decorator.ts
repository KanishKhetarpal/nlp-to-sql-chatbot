import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Exempts a route from the API key guard — health checks and the like. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
