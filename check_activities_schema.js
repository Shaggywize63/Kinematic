require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

async function checkSchema() {
  const { data, error } = await supabaseAdmin
    .from('activities')
    .select('*')
    .limit(1);

  if (error) {
    console.error('Error fetching activities:', error);
    return;
  }

  if (data && data.length > 0) {
    console.log('Columns in activities table:', Object.keys(data[0]));
  } else {
    console.log('No activities found to check columns.');
  }
}

checkSchema();
