/**
 * Automation triggers for CRM activities: `activity_created` and `activity_completed`.
 *
 * Tenants configure automations on these triggers (Settings → Automations) and the engine
 * (`automations.fireForTrigger`) supports them, but nothing in the LIVE activity routes ever fired
 * them: the only code that did lived in `controllers/crm/activities.controller.ts`, which is not
 * mounted anywhere. The live `/crm/activities` and `/crm/tasks` handlers in `routes/crm.routes.ts`
 * call `fireActivityLifecycle` instead.
 *
 * Semantics
 *  - `activity_created`   — a row was inserted.
 *  - `activity_completed` — a row BECAME completed: it was inserted already completed (a logged call
 *    or visit), or an update moved `completed_at` from empty to set. Re-saving an already-completed
 *    activity, or reopening one, never fires it, so a rule runs at most once per completion.
 *
 * Everything here is fire-and-forget: it never throws, so a misconfigured automation can not 500 the
 * activity write that triggered it. Automation ACTIONS that create activities insert rows directly
 * (they do not go through these routes), so an automation can not trigger itself.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';
import * as automations from './automations.service';

export type ActivityTrigger = 'activity_created' | 'activity_completed';
type Row = Record<string, unknown>;
type LinkedEntity = 'lead' | 'deal' | 'contact' | 'account';

/** Which parent record the automation runs against, in priority order (lead first). */
const LINKS: ReadonlyArray<{ column: string; entity: LinkedEntity; table: string }> = [
  { column: 'lead_id', entity: 'lead', table: 'crm_leads' },
  { column: 'deal_id', entity: 'deal', table: 'crm_deals' },
  { column: 'contact_id', entity: 'contact', table: 'crm_contacts' },
  { column: 'account_id', entity: 'account', table: 'crm_accounts' },
];

const isSet = (v: unknown): boolean => v !== null && v !== undefined && v !== '';

/** The triggers a write should fire: `before` is the row as it was (null for an insert), `after` as it is now. */
export function activityTriggersFor(before: Row | null | undefined, after: Row): ActivityTrigger[] {
  const out: ActivityTrigger[] = [];
  if (!before) out.push('activity_created');
  if (!isSet(before?.completed_at) && isSet(after.completed_at)) out.push('activity_completed');
  return out;
}

/** The parent entity an activity is linked to, or null for an unlinked (directory-only) activity. */
export function linkedEntityOf(activity: Row): { entity: LinkedEntity; entity_id: string; table: string } | null {
  for (const l of LINKS) {
    const id = activity[l.column];
    if (typeof id === 'string' && id) return { entity: l.entity, entity_id: id, table: l.table };
  }
  return null;
}

async function fireOne(org_id: string, user_id: string | undefined, trigger: ActivityTrigger, activity: Row): Promise<void> {
  const link = linkedEntityOf(activity);
  if (!link) return; // nothing to run an automation against

  // Actions read the parent record from the context (`{{lead.first_name}}`, the lead's phone for
  // WhatsApp, its owner for "assign to lead owner"), exactly as the lead/deal triggers provide it,
  // so load the full row. If that lookup fails, still fire with just the id: conditions on the
  // activity itself keep working.
  let parent: Row = { id: link.entity_id };
  try {
    const { data } = await supabaseAdmin.from(link.table).select('*').eq('org_id', org_id).eq('id', link.entity_id).maybeSingle();
    if (data) parent = data as Row;
  } catch { /* keep the id-only parent */ }

  // Tenant scoping (see fireForTrigger): the activity's own client, else its parent's.
  const client_id = (activity.client_id as string | null | undefined) ?? (parent.client_id as string | null | undefined) ?? null;

  await automations.fireForTrigger(trigger, {
    org_id,
    user_id,
    entity: link.entity,
    entity_id: link.entity_id,
    data: { activity, [link.entity]: parent, client_id },
  });
}

/**
 * Fire whatever triggers the write implies. Call as `void fireActivityLifecycle(...)` after the row is
 * saved; it resolves once the automations have run and never rejects.
 */
export async function fireActivityLifecycle(
  org_id: string,
  user_id: string | undefined,
  before: Row | null | undefined,
  after: Row,
): Promise<void> {
  for (const trigger of activityTriggersFor(before, after)) {
    try {
      await fireOne(org_id, user_id, trigger, after);
    } catch (err) {
      logger.warn(`[activity-trigger] ${trigger} failed for activity ${String(after.id)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
