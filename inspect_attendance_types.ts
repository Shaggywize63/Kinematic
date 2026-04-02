import { supabaseAdmin } from './src/lib/supabase';

async function inspectColumns() {
  // Query attendance to see one record's data types
  const { data, error } = await supabaseAdmin
    .from('attendance')
    .select('*')
    .limit(1);

  if (error) {
    console.error('Error:', error);
  } else if (data && data.length > 0) {
    console.log('Sample Record:', data[0]);
    // Try to get column metadata via RPC if available, or just check the types of values
    Object.keys(data[0]).forEach(key => {
      console.log(`${key}: ${typeof data[0][key]} (value: ${data[0][key]})`);
    });
  } else {
    console.log('No attendance records found.');
  }
}

inspectColumns();
