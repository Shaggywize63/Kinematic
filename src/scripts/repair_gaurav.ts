import { supabaseAdmin } from '../lib/supabase';
import dotenv from 'dotenv';
dotenv.config();

const GAURAV_EMAIL = 'gaurav@livpure.com';
const LIVPURE_CLIENT_ID = '9a409db5-ec4a-4a24-9894-72f59d380464';

async function diagnose() {
  console.log('--- START ULTIMATE DIAGNOSTIC ---');
  
  // 1. Check Clients Registry
  const { data: clients } = await supabaseAdmin.from('clients').select('id, name, org_id');
  console.log('Registered Clients:', JSON.stringify(clients, null, 2));

  // 2. Check Gaurav's profile in users table
  const { data: gaurav } = await supabaseAdmin.from('users').select('id, name, client_id, role').eq('email', GAURAV_EMAIL).single();
  if (gaurav) {
    console.log('Gaurav Profile:', JSON.stringify(gaurav, null, 2));
    
    // 3. Check permissions in DB directly
    const { data: perms } = await supabaseAdmin.from('user_module_permissions').select('*').eq('user_id', gaurav.id);
    console.log('Gaurav Raw Permissions in user_module_permissions:', perms);
  } else {
    console.error('Gaurav not found in users table.');
  }

  // 4. Leakage Check: Count records for LivPure client_id
  const { count: fsCount } = await supabaseAdmin.from('form_submissions').select('*', { count: 'exact', head: true }).eq('client_id', LIVPURE_CLIENT_ID);
  console.log(`Form Submissions for LivPure ID (${LIVPURE_CLIENT_ID}):`, fsCount);

  // 5. Look for Horizonn Default Client ID
  const horizonnDefault = clients?.find(c => c.name === 'Horizonn Default Client');
  if (horizonnDefault) {
    const { count: fsHCount } = await supabaseAdmin.from('form_submissions').select('*', { count: 'exact', head: true }).eq('client_id', horizonnDefault.id);
    console.log(`Form Submissions for Horizonn Default ID (${horizonnDefault.id}):`, fsHCount);
  }

  // 6. Schema Discovery: Check relationship of user_module_permissions
  const { data: schemaTest } = await supabaseAdmin.rpc('exec_sql', { sql: "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.user_module_permissions'::regclass;" });
  console.log('user_module_permissions Constraints:', schemaTest);

  console.log('--- END ULTIMATE DIAGNOSTIC ---');
}

diagnose();
