import 'dotenv/config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClientFor, anonClientFor, userClientFor, currentProjectKey } from './projects';

// These exports were historically singletons bound to the single SUPABASE_*
// project. They are now thin Proxies that resolve, per property access, to the
// Supabase client for the CURRENT request's project (carried via
// AsyncLocalStorage — see lib/projects + middleware/withProject). Outside any
// request (scripts, cron, module init) they resolve to the DEFAULT project,
// which is exactly the old single-project behaviour. Keeping the same export
// shape means every existing `import { supabase, supabaseAdmin } from
// '../lib/supabase'` call site routes correctly with no change.
function proxyClient(resolve: () => SupabaseClient): SupabaseClient {
  return new Proxy({} as SupabaseClient, {
    get(_target, prop) {
      const real = resolve() as unknown as Record<string | symbol, unknown>;
      const value = real[prop];
      // Bind methods to the real client so `this` is correct; pass through
      // sub-objects (.auth, .storage, .functions, …) untouched.
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
    },
  });
}

// Public client — respects RLS (anon key), current project.
export const supabase: SupabaseClient = proxyClient(() => anonClientFor(currentProjectKey()));

// Admin client — bypasses RLS (service-role key), current project.
export const supabaseAdmin: SupabaseClient = proxyClient(() => adminClientFor(currentProjectKey()));

// Per-request client that acts as the authenticated user (RLS applies),
// against the current project.
export function getUserClient(accessToken: string): SupabaseClient {
  return userClientFor(currentProjectKey(), accessToken);
}
