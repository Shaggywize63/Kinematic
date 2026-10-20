import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { forbidden } from '../utils/response';
import { logger } from '../lib/logger';

/**
 * "Only what Client Management ticked is available" for the API routes that have no module check of their own.
 *
 * Each rule maps a route prefix to the module(s) that unlock it. A request from a client-bound user whose entitlement list
 * is complete (`entitlements_strict`, see lib/entitlements) and does not hold any of them is:
 *   - logged as `[module-shadow]` and let through (default), or
 *   - refused with 403 when MODULE_GATE=enforce.
 * MODULE_GATE=off disables the check. Platform staff, super_admin and demo sessions are never affected.
 *
 * The apps already hide every section whose module is not ticked (lib/appItems.deriveAppUi), so the gate is the belt to
 * that braces — it stops a hand-made request. It ships in shadow mode first because some of these paths are also read as
 * reference data by other screens (cities, zones, stores); the log shows exactly which calls would be refused before it is
 * switched to enforce.
 */
interface Rule { prefix: string; any: string[] }

export const MODULE_RULES: Rule[] = [
  { prefix: '/leave', any: ['leave'] },
  { prefix: '/broadcast', any: ['broadcast'] },
  { prefix: '/learning', any: ['learning'] },
  { prefix: '/leaderboard', any: ['leaderboard'] },
  { prefix: '/sos', any: ['emergency_sos'] },
  { prefix: '/visits', any: ['visit_logs'] },
  { prefix: '/cities', any: ['cities'] },
  { prefix: '/zones', any: ['zones'] },
  { prefix: '/stores', any: ['stores'] },
  { prefix: '/attendance', any: ['attendance'] },
  { prefix: '/route-plan', any: ['orders'] },
  { prefix: '/route-plans', any: ['orders'] },
  { prefix: '/activities', any: ['activities'] },
  { prefix: '/forms', any: ['form_builder'] },
  { prefix: '/planograms', any: ['planograms'] },
];

type Mode = 'off' | 'shadow' | 'enforce';
const mode = (): Mode => {
  const v = (process.env.MODULE_GATE || '').toLowerCase();
  return v === 'off' || v === 'enforce' ? v : 'shadow';
};

export function ruleFor(path: string): Rule | undefined {
  return MODULE_RULES.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`));
}

/** Pure decision: does this user hold any module the rule asks for? */
export function moduleHeld(user: AuthRequest['user'], rule: Rule): boolean {
  const held = user?.enabled_modules ?? [];
  return rule.any.some((m) => held.includes(m));
}

const warned = new Set<string>();

export function moduleGate(req: AuthRequest, res: Response, next: NextFunction) {
  const user = req.user;
  const m = mode();
  if (m === 'off' || !user || user.entitlements_strict !== true) return next();
  if ((user.role || '').toLowerCase() === 'super_admin') return next();
  const rule = ruleFor(req.path);
  if (!rule || moduleHeld(user, rule)) return next();

  if (m === 'enforce') return forbidden(res, `Module not enabled for your account: ${rule.any[0]}`);
  // Shadow: one line per (client, module, route prefix) per process, so the log stays readable.
  const key = `${user.client_id ?? '-'}:${rule.prefix}`;
  if (!warned.has(key)) {
    warned.add(key);
    logger.warn(`[module-shadow] would refuse ${req.method} ${rule.prefix}* for client=${user.client_id ?? '-'} user=${user.id}: needs ${rule.any.join('|')}`);
  }
  return next();
}
