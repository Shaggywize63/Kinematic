const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

async function checkData() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  
  console.log('Checking routes for:', today);
  
  // 1. Check raw route_plans
  const { data: plans, error: pErr } = await supabase
    .from('route_plans')
    .select('id, user_id, plan_date, org_id')
    .filter('plan_date', 'gte', today)
    .filter('plan_date', 'lte', today)
    .limit(10);
    
  if (pErr) console.error('Error fetching plans:', pErr);
  else console.log('Raw Plans found:', JSON.stringify(plans, null, 2));

  // 2. Check view v_route_plan_daily
  const { data: viewPlans, error: vErr } = await supabase
    .from('v_route_plan_daily')
    .select('*')
    .gte('plan_date', today)
    .lte('plan_date', today)
    .limit(10);

  if (vErr) console.error('Error fetching view plans:', vErr);
  else console.log('View Plans found:', JSON.stringify(viewPlans, null, 2));

  // 3. User mapping check
  const emails = plans?.map(p => p.user_id) || [];
  if (emails.length > 0) {
    const { data: users } = await supabase
      .from('users')
      .select('id, email, name')
      .in('id', emails);
    console.log('Mapped Users:', JSON.stringify(users, null, 2));
  }
}

checkData();
