
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

const GAURAV_ID = '93e17afa-8f8c-49b2-8075-375e1f1ec02a';

// List of modules a Client SHOULD have access to by default
const ALLOWED_MODULES = [
  'cities',
  'zones',
  'stores',
  'skus',
  'activities',
  'assets',
  'analytics',
  'live_tracking'
];

async function restoreLimits() {
  console.log('--- RESTORING GAURAV JAIN PERMISSION LIMITS ---');
  
  // 1. Fetch current permissions
  const { data: currentPerms, error: fErr } = await supabaseAdmin
    .from('user_module_permissions')
    .select('module_id')
    .eq('user_id', GAURAV_ID);

  if (fErr) {
    console.error('Error fetching perms:', fErr.message);
    return;
  }

  const currentIds = currentPerms?.map(p => p.module_id) || [];
  console.log('Current Permissions:', currentIds);

  // 2. Identify unauthorized modules
  const unauthorizedIds = currentIds.filter(id => !ALLOWED_MODULES.includes(id));

  if (unauthorizedIds.length === 0) {
    console.log('No unauthorized modules found.');
    return;
  }

  console.log('Targeting Unauthorized Modules for Removal:', unauthorizedIds);

  // 3. Purge unauthorized modules
  const { error: dErr } = await supabaseAdmin
    .from('user_module_permissions')
    .delete()
    .eq('user_id', GAURAV_ID)
    .in('module_id', unauthorizedIds);

  if (dErr) {
    console.error('Error during purge:', dErr.message);
    return;
  }

  console.log('SUCCESS: Gaurav Jain permissions have been restricted to core operational modules.');
  console.log('Retained:', ALLOWED_MODULES);
}

restoreLimits();
