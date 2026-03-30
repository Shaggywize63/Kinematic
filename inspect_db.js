const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
dotenv.config({ path: '/Users/sagbharg/Documents/Kinematic/Kinematic/.env' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const orgId = '346b9a9d-5969-42b7-a367-5f11550974b2'; // From preceding turns

async function inspect() {
  const from = '2026-03-23';
  const to = '2026-03-29';

  const { data: latest } = await supabase.from('form_submissions').select('id, date, org_id').gte('date', from).lte('date', to);
  console.log(`Submissions for ${from} to ${to}:`, latest?.length);
  console.log(`Uniques by Org:`, [...new Set(latest?.map(l=>l.org_id))]);
  console.log(`Submissions Today:`, latest?.filter(l=>l.date === to).length);

  const { data: att } = await supabase.from('attendance').select('status').gte('date', from).lte('date', to);
  console.log(`Leaves in range:`, att?.filter(a=>a.status === 'absent').length);

  const { data: zones } = await supabase.from('zones').select('id, name').limit(5);
  console.log(`Zones Sample:`, zones);
}

inspect();
