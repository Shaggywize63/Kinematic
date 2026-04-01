import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkGauravPermissions() {
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id, email, role, client_id')
    .eq('email', 'gaurav@livpure.com')
    .single();

  if (userError || !user) {
    console.error('Error fetching user:', userError);
    return;
  }

  console.log('User found:', user);

  const { data: perms, error: permsError } = await supabase
    .from('user_module_permissions')
    .select('module_id')
    .eq('user_id', user.id);

  if (permsError) {
    console.error('Error fetching permissions:', permsError);
    return;
  }

  console.log('Current Module Permissions:');
  console.log(JSON.stringify(perms.map(p => p.module_id), null, 2));
}

checkGauravPermissions();
