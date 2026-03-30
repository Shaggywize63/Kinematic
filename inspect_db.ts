import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const orgId = '346b9a9d-5969-42b7-a367-5f11550974b2'; // From context

async function inspect() {
  const today = new Date().toISOString().split('T')[0];
  console.log('Today:', today);

  const { data: activities } = await supabase.from('activities').select('id, name');
  console.log('Activities:', activities);

  const { data: cols } = await supabase.from('form_submissions').select('*').limit(1);
  console.log('Form Submissions Columns:', Object.keys(cols?.[0] || {}));
}

inspect();
