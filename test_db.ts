import { supabaseAdmin } from './src/lib/supabase';

async function test() {
  console.log('🔍 Testing Supabase connection...');
  try {
    const { data, error } = await supabaseAdmin.from('users').select('count', { count: 'exact', head: true });
    if (error) {
      console.error('❌ Connection failed:', error.message);
      process.exit(1);
    }
    console.log('✅ Connection successful! Found users count:', data);
    process.exit(0);
  } catch (err: any) {
    console.error('❌ Unexpected error:', err.message);
    process.exit(1);
  }
}

test();
