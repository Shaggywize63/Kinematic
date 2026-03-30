const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const ANDHERI_WEST_HUB_ID = '10000000-0000-0000-0000-000000000001';

  // Assign active users who don't yet have a zone to Andheri West Hub
  const { data, error } = await supabase
    .from('users')
    .update({ zone_id: ANDHERI_WEST_HUB_ID })
    .in('id', [
      'a01fb0d9-2e13-45ec-9810-3a66b2c58f93', // Sagar
      'eefcd316-bde2-446a-88e7-c63127fa28f9', // Meghna
      'edc94ca9-7dfd-4001-b96d-7128729a9e51', // FE 1
      '01570e68-e0a2-4fcc-b3c8-09b00183b710', // Manvik
      '5115aaf6-d12f-4ed3-a1d2-832aaa8d5a4e', // TestFE
    ])
    .select('id, name, zone_id');

  if (error) {
    console.error('❌ Error updating users:', error.message);
    return;
  }

  console.log(`✅ Updated ${data.length} users to Andheri West Hub:`);
  data.forEach(u => console.log(`  - ${u.name}: zone_id = ${u.zone_id}`));
}

run();
