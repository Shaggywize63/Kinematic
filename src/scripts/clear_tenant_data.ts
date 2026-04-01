import { supabaseAdmin } from '../lib/supabase';

async function clearData() {
  console.log('--- SYSTEM WIDE DATA CLEARANCE ---');
  console.log('Clearing all management and transactional data for fresh synchronization...');

  const assetTables = [
    'stores',
    'cities',
    'zones',
    'skus',
    'activities',
    'assets'
  ];

  const transactionalTables = [
    'form_submissions',
    'attendance',
    'visit_logs',
    'sos_alerts',
    'broadcast_responses',
    'route_plans'
  ];

  console.log('Clearing Transactional Data...');
  for (const table of transactionalTables) {
    console.log(`- ${table}...`);
    await supabaseAdmin.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
  }

  console.log('Clearing Management Assets...');
  for (const table of assetTables) {
    console.log(`- ${table}...`);
    await supabaseAdmin.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
  }

  console.log('Clearing Manpower (excluding platform admins)...');
  // Safer query to avoid enum mismatch errors
  const { error: userErr } = await supabaseAdmin
    .from('users')
    .delete()
    .neq('role', 'super_admin')
    .neq('role', 'admin');

  if (userErr) {
    console.error('Error clearing users:', userErr.message);
  } else {
    console.log('- users cleared.');
  }

  console.log('System cleared. Ready for fresh multi-tenant synchronization.');
}

clearData();
