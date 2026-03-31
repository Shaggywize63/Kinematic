import { supabaseAdmin } from './src/lib/supabase';
import fs from 'fs';
import path from 'path';

async function runMigration() {
  const sqlPath = path.join(__dirname, 'src', 'scripts', 'rbac_migration.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  
  console.log('Running RBAC Migration...');
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql_query: sql });
  
  if (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } else {
    console.log('RBAC Migration successful');
  }
}

runMigration();
