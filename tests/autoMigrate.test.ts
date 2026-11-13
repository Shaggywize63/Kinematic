import { PENDING_MIGRATIONS } from '../src/lib/migrations/pendingMigrations.generated';
import { stripTopLevelTxnControl } from '../src/lib/autoMigrate';

/**
 * Guards the embedded migration bundle that the boot-time runner
 * (src/lib/autoMigrate.ts) applies. These assertions protect against a bad or
 * stale regeneration of pendingMigrations.generated.ts.
 */
describe('embedded pending migrations', () => {
  const EXPECTED_ORDER = [
    'migration_makes_brands.sql',
    'migration_lead_ref_and_type.sql',
    'migration_expense_lead_deal_links.sql',
    'migration_expense_links_clarification.sql',
    'migration_form_ref_no.sql',
    'migration_account_location.sql',
    'migration_activity_type_check.sql',
    'migration_user_roles.sql',
  ];

  it('embeds exactly the expected migrations in apply order', () => {
    expect(PENDING_MIGRATIONS.map((m) => m.name)).toEqual(EXPECTED_ORDER);
  });

  it('every migration has non-empty SQL', () => {
    for (const m of PENDING_MIGRATIONS) {
      expect(m.sql.trim().length).toBeGreaterThan(0);
    }
  });

  it('contains no obviously destructive statements (no DROP TABLE / TRUNCATE / DELETE / DROP COLUMN)', () => {
    const banned = /\b(drop\s+table|truncate|delete\s+from|drop\s+column)\b/i;
    for (const m of PENDING_MIGRATIONS) {
      expect(banned.test(m.sql)).toBe(false);
    }
  });

  it('is written to be idempotent (each migration uses IF [NOT] EXISTS / OR REPLACE)', () => {
    const idempotent = /if\s+not\s+exists|if\s+exists|or\s+replace/i;
    for (const m of PENDING_MIGRATIONS) {
      expect(idempotent.test(m.sql)).toBe(true);
    }
  });

  const topLevelTxn = /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;\s*$/im;

  // The boot runner applies SQL through exec_migration (PL/pgSQL EXECUTE), which
  // cannot run transaction commands ("EXECUTE of transaction commands is not
  // implemented"). stripTopLevelTxnControl() is the safety net, so after it runs
  // NO embedded migration may still carry a standalone top-level BEGIN;/COMMIT;.
  it('every embedded migration is free of top-level BEGIN;/COMMIT; after sanitizing', () => {
    for (const m of PENDING_MIGRATIONS) {
      expect(topLevelTxn.test(stripTopLevelTxnControl(m.sql))).toBe(false);
    }
  });

  // migration_user_roles.sql is applied FRESH through exec_migration (it was
  // never pre-applied via psql like the older ones), so its SOURCE must already
  // be clean — it must not depend on the sanitizer to run. Guards against the
  // regression that left user_roles unapplied in production.
  it('migration_user_roles.sql has no top-level BEGIN;/COMMIT; in its source', () => {
    const m = PENDING_MIGRATIONS.find((x) => x.name === 'migration_user_roles.sql');
    expect(m).toBeDefined();
    expect(topLevelTxn.test(m!.sql)).toBe(false);
  });
});

describe('stripTopLevelTxnControl', () => {
  it('removes standalone top-level transaction-control lines', () => {
    const sql = 'BEGIN;\nCREATE TABLE IF NOT EXISTS x (id int);\nCOMMIT;';
    const out = stripTopLevelTxnControl(sql);
    expect(out).not.toMatch(/^\s*BEGIN;\s*$/m);
    expect(out).not.toMatch(/^\s*COMMIT;\s*$/m);
    expect(out).toContain('CREATE TABLE IF NOT EXISTS x (id int);');
  });

  it('leaves BEGIN/END inside a DO $$ … $$ PL/pgSQL block untouched', () => {
    const sql = 'DO $$\nBEGIN\n  EXECUTE \'GRANT SELECT ON x TO authenticated\';\nEND $$;';
    const out = stripTopLevelTxnControl(sql);
    // The block's own BEGIN/END (no trailing bare ";") must survive verbatim.
    expect(out).toBe(sql);
  });

  it('is a no-op for SQL with no transaction control', () => {
    const sql = 'CREATE INDEX IF NOT EXISTS i ON x (id);';
    expect(stripTopLevelTxnControl(sql)).toBe(sql);
  });
});
