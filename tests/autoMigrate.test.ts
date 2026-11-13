import { PENDING_MIGRATIONS } from '../src/lib/migrations/pendingMigrations.generated';

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
});
