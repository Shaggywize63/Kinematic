import { supabaseAdmin } from './src/lib/supabase';
async function check() {
  const { data: user } = await supabaseAdmin.from('users').select('*').eq('name', 'Test FE').single();
  console.log('User:', user?.id, user?.name);
  if (user) {
    const today = new Date(new Date().getTime() + 5.5 * 3600000).toISOString().split('T')[0];
    const { data: att } = await supabaseAdmin.from('attendance').select('*').eq('user_id', user.id).eq('date', today).maybeSingle();
    console.log('Attendance for today:', !!att, att?.status, att?.date);
  }
}
check();
