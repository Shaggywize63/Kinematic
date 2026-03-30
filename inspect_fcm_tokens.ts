import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing supabase env vars");
  process.exit(1);
}

const db = createClient(supabaseUrl, supabaseServiceKey);

async function checkTokens() {
  const { data, error } = await db.from('users').select('id, name, fcm_token').not('fcm_token', 'is', null);
  if (error) {
    console.error("Error fetching tokens:", error);
  } else {
    console.log(`Found ${data.length} users with FCM tokens registered:`);
    console.log(JSON.stringify(data, null, 2));
  }
}

checkTokens();
