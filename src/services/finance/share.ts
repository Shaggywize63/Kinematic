import { currentProjectKey } from '../../lib/projects';

const DASHBOARD_FALLBACK = 'https://dashboard.kinematicapp.com';

export function dashboardBase(): string {
  const raw = (process.env.DASHBOARD_URL || '').trim().replace(/\/$/, '');
  if (!raw) return DASHBOARD_FALLBACK;
  try { new URL(raw); } catch { return DASHBOARD_FALLBACK; }
  return raw;
}

/**
 * Public, no-login link to an invoice/quote. The page lives on the dashboard
 * (/inv/:token) and sends `?p=` back as X-Kinematic-Project, because a public
 * request has no bearer token to derive the Supabase project from and the
 * production fallback is the Tata project.
 */
export function publicDocUrl(token: string): string {
  return `${dashboardBase()}/inv/${encodeURIComponent(token)}?p=${encodeURIComponent(currentProjectKey())}`;
}
