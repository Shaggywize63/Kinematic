import { Request, Response, NextFunction } from 'express';
import { runWithDemoIndustry } from '../lib/demoContext';

/**
 * Reads the `X-Demo-Industry` header and runs the rest of the request inside
 * that vertical's AsyncLocalStorage context, so the demo middlewares and the
 * getMock* fixtures resolve to the matching industry dataset. Missing/unknown
 * values fall back to 'generic' (today's behaviour). Cheap and side-effect
 * free for non-demo traffic — only the demo middlewares read the value.
 *
 * Mounted at /api/v1 (mirrors withProject) so it wraps both the CRM router's
 * demoCrmMiddleware and the global demoExtensionsMiddleware.
 */
export function withDemoIndustry(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers['x-demo-industry'];
  runWithDemoIndustry(Array.isArray(header) ? header[0] : header, () => next());
}
