import { supabaseAdmin } from '../lib/supabase';
import dotenv from 'dotenv';
dotenv.config();

const GAURAV_EMAIL = 'gaurav@livpure.com';

async function finalSync() {
  console.log('--- FINAL PERMISSION SYNC ---');
  
  // 1. Get Gaurav's profile
  const { data: gaurav } = await supabaseAdmin.from('users').select('id').eq('email', GAURAV_EMAIL).single();
  if (!gaurav) {
    console.error('Gaurav not found.');
    return;
  }

  // 2. Define the full permission set for this client admin
  const modules = [
    'analytics',
    'attendance',
    'orders',
    'users',
    'reports',
    'inventory',
    'grievances',
    'visit_logs',
    'form_builder'
  ];

  const upsertData = modules.map(m => ({ user_id: gaurav.id, module_id: m }));

  const { error } = await supabaseAdmin.from('user_module_permissions').upsert(upsertData, { onConflict: 'user_id,module_id' });
  
  if (error) {
    console.error('Sync failed:', error.message);
  } else {
    console.log('✅ All 9 modules synced for Gaurav Jain.');
  }

  console.log('--- SYNC COMPLETE ---');
}

finalSync();
