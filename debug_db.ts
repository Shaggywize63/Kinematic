
import { supabaseAdmin } from './src/lib/supabase';

async function checkData() {
  console.log('--- DB DIAGNOSTIC ---');
  
  // 1. Current UTC time on server
  console.log('Server UTC Time:', new Date().toISOString());
  
  // 2. Sample Submission
  const { data: subs } = await supabaseAdmin.from('form_submissions').select('submitted_at, org_id').order('submitted_at', { ascending: false }).limit(3);
  console.log('Recent Submissions:', subs);

  // 3. Sample Route Plan
  const { data: plans } = await supabaseAdmin.from('route_plans').select('plan_date, user_id, org_id').limit(3);
  console.log('Recent Route Plans:', plans);

  // 4. Check Sagar User
  const { data: user } = await supabaseAdmin.from('users').select('id, name, org_id, role').eq('name', 'Sagar').maybeSingle();
  console.log('User Sagar:', user);

  // 5. Test Query Range for April 9th IST
  const start = '2026-04-08T18:30:00Z';
  const end = '2026-04-09T18:29:59.999Z';
  
  const { count: sCount } = await supabaseAdmin.from('form_submissions').select('*', { count: 'exact', head: true }).gte('submitted_at', start).lte('submitted_at', end);
  console.log(`Submissions in range (April 9 IST): ${sCount}`);

  const { count: rCount } = await supabaseAdmin.from('route_plans').select('*', { count: 'exact', head: true }).gte('plan_date', start).lte('plan_date', end);
  console.log(`Route Plans in range (April 9 IST): ${rCount}`);

  const { count: rCountEq } = await supabaseAdmin.from('route_plans').select('*', { count: 'exact', head: true }).eq('plan_date', '2026-04-10');
  console.log(`Route Plans for April 10 (exact EQ): ${rCountEq}`);
}

checkData();
