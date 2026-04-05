import { supabaseAdmin as supabase } from './src/lib/supabase';
import { todayDate } from './src/utils';

async function check() {
  const today = todayDate();
  console.log(`Checking routes for today: ${today}`);

  const { data: plans, error } = await supabase
    .from('route_plans')
    .select('*, user:users(name, email)')
    .eq('plan_date', today);

  if (error) {
    console.error('Error fetching plans:', error.message);
    return;
  }

  console.log(`Found ${plans?.length || 0} plans for today.`);
  
  plans?.forEach(p => {
    console.log(`Plan ID: ${p.id}, User: ${p.user?.name || 'Unknown'}, Status: ${p.status}`);
  });
}

check();
