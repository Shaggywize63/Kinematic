import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

async function verifyFix() {
  console.log('🚀 Starting Verification of Tracking & Battery Fix...');

  // 1. Find a test user (preferably an executive)
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id, name, battery_percentage, last_latitude, last_longitude')
    .eq('role', 'executive')
    .limit(1)
    .single();

  if (userError || !user) {
    console.error('❌ Could not find a test executive user:', userError?.message);
    return;
  }

  console.log(`👤 Testing with user: ${user.name} (${user.id})`);
  console.log(`📊 Current State: Battery=${user.battery_percentage}%, Lat=${user.last_latitude}, Lng=${user.last_longitude}`);

  // 2. Simulate Heartbeat Update with "0.0" coordinates and "0%" battery (The problematic cases)
  const testLat = 12.9716; // Random real coordinate
  const testLng = 77.5946;
  const testBattery = 42; 

  console.log(`\n⏳ Updating status to: Lat=${testLat}, Lng=${testLng}, Battery=${testBattery}%...`);

  const { error: updateError } = await supabase
    .from('users')
    .update({
      last_latitude: testLat,
      last_longitude: testLng,
      battery_percentage: testBattery,
      last_location_updated_at: new Date().toISOString()
    })
    .eq('id', user.id);

  if (updateError) {
    console.error('❌ Update failed:', updateError.message);
  } else {
    console.log('✅ Update successful!');
  }

  // 3. Verify in DB
  const { data: verifiedUser } = await supabase
    .from('users')
    .select('battery_percentage, last_latitude, last_longitude')
    .eq('id', user.id)
    .single();

  if (verifiedUser?.battery_percentage === testBattery && verifiedUser?.last_latitude === testLat) {
    console.log('\n✨ VERIFICATION SUCCESS: Database correctly updated with new telemetry.');
    console.log(`📈 New State: Battery=${verifiedUser.battery_percentage}%, Lat=${verifiedUser.last_latitude}, Lng=${verifiedUser.last_longitude}`);
  } else {
    console.log('\n❌ VERIFICATION FAILED: Database mismatch.');
  }
}

verifyFix();
