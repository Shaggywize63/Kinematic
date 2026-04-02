
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function check() {
  console.log('--- Inducing Error and Capturing Clues ---');
  // Intentionally ambiguous join
  const { data, error } = await supabase.from('attendance').select('id, users(*)').limit(1);
  if (error) {
     console.log('--- ERROR BODY ---');
     console.log(JSON.stringify(error, null, 2));
     console.log('--- MESSAGE ---');
     console.log(error.message);
     console.log('--- HINT (IMPORTANT) ---');
     console.log((error as any).hint);
     console.log('--- DETAILS ---');
     console.log((error as any).details);
  } else {
     console.log('No error triggered? This is unexpected.');
  }
}
check();
