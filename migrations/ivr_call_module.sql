-- Register the IVR Call module in the catalog.
--
-- IVR Call is the app/dashboard "IVR Call" button: an outbound click-to-call placed through the org's
-- configured telephony provider (CallerDesk) instead of the native dialer, so the call is bridged on the
-- virtual number and recorded. The backend path already exists (telephony.service click-to-call +
-- call_recording webhook); this module is the per-client gate the apps surface the button on.
--
-- Non-universal + granted to NO client here = OFF by default for every tenant. A master admin turns it on
-- per client from the dashboard Clients page (client_modules row); the app/dashboard then show the IVR Call
-- action via the enabled_modules entitlement, and the click-to-call endpoint checks the same module.
-- The CallerDesk credentials + DID live in the client's Call Recording integration config, NOT here.
-- Idempotent — safe to re-run. Apply to every Supabase project the backend serves (default/Tata + kinematic).
insert into modules (id, name, description, package, is_universal)
values (
  'ivr_call',
  'IVR Call',
  'Place a recorded click-to-call to a lead through the org''s IVR provider (CallerDesk); the agent is rung first, then the customer, and the call is bridged on the virtual number and recorded.',
  'crm',
  false
)
on conflict (id) do update set
  name        = excluded.name,
  description = excluded.description,
  package     = excluded.package,
  is_universal = excluded.is_universal;
