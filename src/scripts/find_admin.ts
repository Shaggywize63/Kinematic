import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

async function findSuperAdmin() {
  const { data, error } = await supabase
    .from('users')
    .select('email, role')
    .eq('role', 'super_admin');

  if (error) {
    console.error('Error fetching users:', error);
    return;
  }

  console.log('Super Admins found:');
  console.log(JSON.stringify(data, null, 2));

  if (data.length === 0) {
    const { data: allAdmins } = await supabase.from('users').select('email, role').eq('role', 'admin').limit(5);
    console.log('No super_admin found. Sampling admin roles:');
    console.log(JSON.stringify(allAdmins, null, 2));
  }
}

findSuperAdmin();
