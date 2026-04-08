import { supabaseAdmin } from './src/lib/supabase';
import fs from 'fs';
import path from 'path';

async function applyMigration() {
  const sqlPath = path.join(__dirname, 'migration_activity_tracking.sql');
  if (!fs.existsSync(sqlPath)) {
    console.error('Migration file not found at:', sqlPath);
    process.exit(1);
  }
  
  const sql = fs.readFileSync(sqlPath, 'utf8');
  
  console.log('Applying Activity Tracking Migration...');
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql_query: sql });
  
  if (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } else {
    console.log('Activity Tracking Migration successful!');
  }
}

applyMigration();
