import { supabaseAdmin } from './src/lib/supabase';
import { todayDate } from './src/utils';

async function cleanup() {
  const today = todayDate();
  console.log(`Cleaning up attendance for 'Test FE' on ${today}`);
  
  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id')
    .ilike('name', '%Test FE%')
    .maybeSingle();

  if (!user) {
    console.log("No user found with name matching 'Test FE'");
    return;
  }

  console.log(`Found User ID: ${user.id}`);
  
  const { error: delErr } = await supabaseAdmin
    .from('attendance')
    .delete()
    .eq('user_id', user.id)
    .eq('date', today);

  if (delErr) {
    console.error("Error deleting attendance:", delErr.message);
  } else {
    console.log("Successfully removed attendance for Test FE today.");
  }
}

cleanup();
