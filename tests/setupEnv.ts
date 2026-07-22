/**
 * Runs before every test module import (jest `setupFiles`).
 *
 * `src/lib/projects.ts` throws at *module load* if the three default-project
 * Supabase vars are missing, and importing the Express app (or any service)
 * transitively loads it. These are placeholder values — the real client is
 * never dialed: data-layer tests mock `src/lib/supabase`, and HTTP E2E tests
 * authenticate with the demo-token bypass, which never touches Supabase.
 */
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || 'test-jwt-secret-please-ignore';
// Keep the Tally poller and other prod-only side effects off.
process.env.DISABLE_TALLY_POLLER = 'true';
// Silence winston during tests unless a test explicitly wants logs.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
