import { createClient } from '@supabase/supabase-client';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase credentials in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function resetTelemetry() {
  console.log('🔄 Resetting stale telemetry data for all executives...');

  const { data, error } = await supabase
    .from('users')
    .update({ 
      battery_percentage: null,
      last_latitude: null,
      last_longitude: null,
      last_location_updated_at: null
    })
    .eq('role', 'executive');

  if (error) {
    console.error('❌ Failed to reset telemetry:', error.message);
  } else {
    console.log('✅ Telemetry reset successfully. Real-time updates will now populate these fields.');
    
    // Verify a few users
    const { data: users } = await supabase
      .from('users')
      .select('id, name, battery_percentage')
      .eq('role', 'executive')
      .limit(5);
    
    console.log('📊 Sample Users after reset:');
    users?.forEach(u => console.log(` - ${u.name}: ${u.battery_percentage}%`));
  }
}

resetTelemetry();
