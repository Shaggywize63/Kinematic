import { supabaseAdmin } from '../lib/supabase';

async function check() {
  const userId = '7d788549-6cb7-451d-832e-446c6cd63b72'; // Test FE from previous contexts
  console.log('Checking all attendance for user:', userId);
  
  const { data, error } = await supabaseAdmin
    .from('attendance')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(5);
    
  if (error) console.error('Error:', error);
  else console.log('Recent Attendance Records:', JSON.stringify(data, null, 2));

  const now = new Date();
  console.log('Server UTC Time:', now.toISOString());
  console.log('Server Locale String (Asia/Kolkata):', now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}
check();
