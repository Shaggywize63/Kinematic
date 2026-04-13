
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  const from = '2026-04-07';
  const to = '2026-04-13';
  
  console.log(`Checking attendance between ${from} and ${to}...`);
  
  const { data, error } = await supabase
    .from('attendance')
    .select('id, date, org_id, user_id, status, created_at')
    .gte('date', from)
    .lte('date', to)
    .limit(10);
    
  if (error) {
    console.error('Error:', error);
    return;
  }
  
  console.log(`Found ${data.length} records in range.`);
  data.forEach(r => {
    console.log(`- ID: ${r.id}, Date: ${r.date}, Org: ${r.org_id}, Status: ${r.status}`);
  });

  const { data: orgs } = await supabase.from('organizations').select('id, name');
  console.log('\nOrganizations:');
  orgs?.forEach(o => console.log(`- ${o.id}: ${o.name}`));
}

check();
