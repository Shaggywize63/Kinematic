
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  const orgId = '346b9a9d-5969-42b7-a367-5f11550974b2';
  const combinations = [
    { hint: 'user_id', zonesHint: 'zone_id', label: 'users!user_id, zones!zone_id' },
    { hint: 'attendance_user_id_fkey', zonesHint: 'zone_id', label: 'users!attendance_user_id_fkey, zones!zone_id' },
    { hint: 'user_id', zonesHint: 'users_zone_id_fkey', label: 'users!user_id, zones!users_zone_id_fkey' },
    { hint: 'attendance_user_id_fkey', zonesHint: 'users_zone_id_fkey', label: 'users!attendance_user_id_fkey, zones!users_zone_id_fkey' },
  ];

  for (const c of combinations) {
    const { error } = await supabase
      .from('attendance')
      .select(`id, users!${c.hint}(name, zones!${c.zonesHint}(name))`)
      .eq('org_id', orgId)
      .limit(1);
    
    if (error) {
      console.log(`[FAILED] ${c.label}: ${error.message}`);
    } else {
      console.log(`[SUCCESS] ${c.label}`);
    }
  }
}
check();
