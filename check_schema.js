require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

async function checkSchema() {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .limit(1);

  if (error) {
    console.error('Error fetching users:', error);
    return;
  }

  if (data && data.length > 0) {
    console.log('Columns in users table:', Object.keys(data[0]));
  } else {
    console.log('No users found to check columns.');
  }
}

checkSchema();
