import { supabaseAdmin } from '../lib/supabase';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

async function applyMigration() {
  console.log('--- START MIGRATION ---');
  
  const sqlPath = path.join(__dirname, 'redefine_kpi_view.sql');
  if (!fs.existsSync(sqlPath)) {
    console.error('Migration SQL file not found at:', sqlPath);
    return;
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');
  console.log('Applying redefine_kpi_view.sql...');

  const { data, error } = await supabaseAdmin.rpc('exec_sql', { sql });

  if (error) {
    console.error('Migration FAILED:', error.message);
    console.log('Attempting direct execution fallback...');
    // Some Supabase projects don't have exec_sql enabled. 
    // Usually we need to use the SQL Editor in the Dashboard for DDL like VIEWs if RPC is restricted.
  } else {
    console.log('Migration SUCCESSFUL. View "v_daily_kpis" redefined.');
  }

  console.log('--- END MIGRATION ---');
}

applyMigration();
