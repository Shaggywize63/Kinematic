import { supabaseAdmin } from './src/lib/supabase';
async function f() {
  const { data } = await supabaseAdmin.from('attendance').select('*').limit(1);
  if (data && data[0]) {
    console.log('Columns:', Object.keys(data[0]));
    console.log('Sample Data:', data[0]);
  }
}
f();
