import { z } from 'zod';
import { validateRouteEdgeOptions } from '../caddy-site-file.js';

// The same Caddy network validator serves guided recovery and service routes.
// Never widen a confirmed restriction when deriving a managed service route.
export const restrictedNetwork = z.string().max(50).refine(value => !/\/0$/.test(value) && !validateRouteEdgeOptions({ ip_allowlist: [value] }).error, 'Use an approved restricted IP address or CIDR.');
