
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

async function findGhostByMobile() {
  console.log('--- TARGETED AUTH SEARCH (MOBILE=00000000) ---');
  const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers();
  
  if (error) {
    console.error('Error:', error.message);
    return;
  }

  const target = users.find(u => 
    u.phone === '00000000' || 
    u.user_metadata?.mobile === '00000000' ||
    u.email?.includes('00000000') ||
    u.phone?.includes('00000000')
  );

  if (target) {
    console.log(`FOUND GHOST: ID=${target.id} | Email=${target.email} | Meta=${JSON.stringify(target.user_metadata)}`);
    // Delete it immediately
    const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(target.id);
    if (!delErr) console.log('DELETED FROM AUTH.');
  } else {
    console.log('No user with mobile 00000000 found in first page of Auth.');
  }

  // Also check the users table
  const { data: dbEntry } = await supabaseAdmin.from('users').select('*').eq('mobile', '00000000');
  if (dbEntry && dbEntry.length > 0) {
    console.log(`FOUND GHOST IN DB: ${dbEntry.length} records`);
    const { error: delDbErr } = await supabaseAdmin.from('users').delete().eq('mobile', '00000000');
    if (!delDbErr) console.log('DELETED FROM DB.');
  }
}

findGhostByMobile();
