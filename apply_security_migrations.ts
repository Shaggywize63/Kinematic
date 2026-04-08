import { supabaseAdmin } from './src/lib/supabase';
import fs from 'fs';
import path from 'path';

async function runMigration() {
  const migrations = [
    'migration_security_alerts.sql',
    'migration_device_info.sql'
  ];

  for (const filename of migrations) {
    const sqlPath = path.join(process.cwd(), filename);
    if (!fs.existsSync(sqlPath)) {
      console.warn(`⚠️ Migration file not found: ${filename}`);
      continue;
    }

    const sql = fs.readFileSync(sqlPath, 'utf8');
    console.log(`🚀 Running Migration: ${filename}...`);
    
    try {
      const { error } = await supabaseAdmin.rpc('exec_sql', { sql_query: sql });
      if (error) {
        console.error(`❌ Migration failed [${filename}]:`, error);
      } else {
        console.log(`✅ Migration successful: ${filename}`);
      }
    } catch (e: any) {
      console.error(`💥 Runtime error during migration [${filename}]:`, e.message);
    }
  }
}

runMigration().then(() => console.log('🏁 All attempted migrations complete.'));
