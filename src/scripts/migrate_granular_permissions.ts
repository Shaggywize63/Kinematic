import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

async function migratePermissions() {
  console.log('Starting granular permission migration...');

  // 1. Handle Master Data Split
  const { data: mdUsers } = await supabase
    .from('user_module_permissions')
    .select('user_id')
    .eq('module_id', 'master_data');

  if (mdUsers && mdUsers.length > 0) {
    const newPerms = mdUsers.flatMap(u => [
      { user_id: u.user_id, module_id: 'cities' },
      { user_id: u.user_id, module_id: 'zones' },
      { user_id: u.user_id, module_id: 'stores' },
      { user_id: u.user_id, module_id: 'activities' }
    ]);
    
    const { error: mdError } = await supabase.from('user_module_permissions').insert(newPerms);
    if (mdError) console.error('Error migrating master_data:', mdError);
    else console.log(`Migrated ${mdUsers.length} users from master_data to granular items.`);
  }

  // 2. Handle Resources Split
  const { data: resUsers } = await supabase
    .from('user_module_permissions')
    .select('user_id')
    .eq('module_id', 'resources');

  if (resUsers && resUsers.length > 0) {
    const newResPerms = resUsers.flatMap(u => [
      { user_id: u.user_id, module_id: 'skus' },
      { user_id: u.user_id, module_id: 'assets' }
    ]);
    
    const { error: resError } = await supabase.from('user_module_permissions').insert(newResPerms);
    if (resError) console.error('Error migrating resources:', resError);
    else console.log(`Migrated ${resUsers.length} users from resources to granular items.`);
  }

  console.log('Migration complete.');
}

migratePermissions();
