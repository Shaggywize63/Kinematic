import { supabaseAdmin } from './src/lib/supabase';

async function inspectUser() {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, name, org_id, role, zone_id')
    .ilike('name', '%Test FE%')
    .single();

  if (error) {
    console.error('Error:', error);
  } else {
    console.log('Found User:', JSON.stringify(data, null, 2));
    
    // Now check their attendance TODAY
    const today = new Date(new Date().getTime() + 5.5 * 3600000).toISOString().split('T')[0];
    const { data: att } = await supabaseAdmin
      .from('attendance')
      .select('*')
      .eq('user_id', data.id)
      .eq('date', today);
    
    console.log(`Attendance for ${today}:`, JSON.stringify(att, null, 2));
  }
}

inspectUser();
