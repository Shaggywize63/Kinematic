import { supabaseAdmin } from './src/lib/supabase';

async function checkSchema() {
  const { data, error } = await supabaseAdmin
    .from('attendance')
    .select('*')
    .limit(1);

  if (error) {
    console.error('Error fetching attendance:', error);
  } else if (data && data.length > 0) {
    console.log('Attendance Record Columns:', Object.keys(data[0]));
  } else {
    // If no data, try to get column names from information_schema
    const { data: cols, error: colError } = await supabaseAdmin
      .rpc('get_table_columns', { table_name: 'attendance' });
    
    if (colError) {
      console.error('Error fetching columns:', colError);
      // Fallback: search for potential spelling errors in the code
    } else {
      console.log('Attendance Columns:', cols);
    }
  }
}

checkSchema();
