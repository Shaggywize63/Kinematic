import dotenv from 'dotenv';
import path from 'path';
const envPath = path.resolve(process.cwd(), '.env');
dotenv.config({ path: envPath });

async function resetBattery() {
  console.log(`🔄 Loading env from: ${envPath}`);
  const { supabaseAdmin } = require('../lib/supabase');
  
  console.log('🔄 Resetting all user battery percentages to NULL...');
  
  const { error } = await supabaseAdmin
    .from('users')
    .update({ battery_percentage: null });

  if (error) {
    console.error('❌ Failed to reset battery:', error.message);
  } else {
    console.log('✅ Success! All battery percentages cleared.');
  }
}

resetBattery();
