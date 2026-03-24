import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing env vars');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function backfill() {
  console.log('Fetching records with missing total_hours...');
  
  const { data: records, error } = await supabase
    .from('attendance')
    .select('*')
    .eq('status', 'checked_out')
    .is('total_hours', null);

  if (error) {
    console.error('Fetch error:', error);
    return;
  }

  console.log(`Found ${records?.length} records to backfill.`);

  for (const record of records || []) {
    if (!record.checkin_at || !record.checkout_at) continue;

    const ci = new Date(record.checkin_at).getTime();
    const co = new Date(record.checkout_at).getTime();
    
    // Simple duration calculation matching the dashboard
    let durationMs = co - ci;
    if (co < ci) durationMs += 24 * 60 * 60 * 1000; // Midnight crossover
    
    const totalMinutes = Math.round(durationMs / 60000);
    const workingMinutes = totalMinutes - (record.break_minutes || 0);
    const totalHours = Number((Math.max(0, workingMinutes) / 60).toFixed(2));

    console.log(`Updating record ${record.id} (${record.date}): ${totalHours} hrs`);

    const { error: updateError } = await supabase
      .from('attendance')
      .update({ total_hours: totalHours })
      .eq('id', record.id);

    if (updateError) {
      console.error(`Update error for ${record.id}:`, updateError);
    }
  }

  console.log('Backfill complete!');
}

backfill();
