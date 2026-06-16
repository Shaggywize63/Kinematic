-- crm_activity_subjects was created without the standard audit /
-- soft-delete columns that the generic CRUD helpers in
-- src/services/crm/crud.service.ts assume every "normal" CRM table has:
--   * list() / clientScopedList() filter `.is('deleted_at', null)`
--   * create() stamps `created_by`, update() stamps `updated_by`
--   * softDelete() writes `deleted_at`
-- The /activity-subjects routes use this audit + soft-delete path (like
-- crm_contacts / crm_lead_sources), so the missing columns produced:
--   "column crm_activity_subjects.deleted_at does not exist"  (GET list)
--   "Could not find the 'created_by' column ..."              (POST create)
-- Add the columns so the schema matches the route code.

alter table public.crm_activity_subjects
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid,
  add column if not exists deleted_at timestamptz;

-- Partial index keeps the "live rows" list query fast, mirroring the
-- soft-delete filter applied by clientScopedList.
create index if not exists crm_activity_subjects_active_idx
  on public.crm_activity_subjects (org_id, position)
  where deleted_at is null;
