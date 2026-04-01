
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

async function globalHunt() {
  console.log('--- GLOBAL DATABASE HUNT for "DIAGNOSTIC" ---');
  
  // 1. Get all tables in public schema
  const { data: tables, error: tableError } = await supabaseAdmin.rpc('get_all_tables');
  
  // If RPC not found, try a known list
  const tableList = tables || ['users', 'candidates', 'attendance', 'visit_logs', 'form_submissions', 'reports', 'zones', 'stores', 'skus', 'activities', 'assets', 'management', 'clients'];
  
  for (const table of tableList) {
    try {
      const { data, error } = await supabaseAdmin.from(table).select('*');
      if (error) {
        console.log(`- Skipping ${table} (error: ${error.message})`);
        continue;
      }
      
      const jsonData = JSON.stringify(data);
      if (jsonData.includes('DIAGNOSTIC') || jsonData.includes('JOINED')) {
        console.log(`!!! FOUND IN TABLE: ${table}`);
        const matches = data.filter(r => JSON.stringify(r).includes('DIAGNOSTIC') || JSON.stringify(r).includes('JOINED'));
        console.log(JSON.stringify(matches, null, 2));
        
        // AUTO PURGE IF REQUESTED ? No, just log first.
      }
    } catch (e) {
      console.log(`- Error querying ${table}`);
    }
  }
}

globalHunt();
