import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials in .env');
  process.exit(1);
}

const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

async function check() {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, name, battery_percentage, last_location_updated_at')
    .ilike('name', '%Test FE%');
  
  if (error) {
    console.error('Error fetching users:', error);
    return;
  }
  
  console.log('--- TEST FE TELEMETRY STATUS ---');
  console.log(JSON.stringify(data, null, 2));
}

check();
