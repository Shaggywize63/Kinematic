import { supabaseAdmin } from './src/lib/supabase';

async function checkSchema() {
  const { data: nData, error: nErr } = await supabaseAdmin.from('notifications').select('*').limit(1);
  const { data: bData, error: bErr } = await supabaseAdmin.from('notification_broadcasts').select('*').limit(1);
  
  if (nData) console.log("nData cols:", nData[0] ? Object.keys(nData[0]) : "No rows");
  if (bData) console.log("bData cols:", bData[0] ? Object.keys(bData[0]) : "No rows");
}

checkSchema();
