import fs from 'fs';
import path from 'path';
import { supabaseAdmin } from '../lib/supabase';

async function runMigration() {
  const sqlFile = process.argv[2];
  if (!sqlFile) {
    console.error('❌ Error: Please provide a SQL file path.');
    process.exit(1);
  }

  const filePath = path.resolve(process.cwd(), sqlFile);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ Error: File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`🚀 Executing: ${sqlFile}...`);
  const sqlContent = fs.readFileSync(filePath, 'utf8');

  try {
    // 1. Detect if it's a query or a migration
    const isQuery = sqlContent.trim().toUpperCase().startsWith('SELECT');
    const rpcName = isQuery ? 'exec_sql' : 'exec_migration';

    console.log(`   Mode: ${isQuery ? 'Query (Returns Data)' : 'Migration (DDL/DML)'}`);

    const { data, error } = await supabaseAdmin.rpc(rpcName, { sql_query: sqlContent });

    if (error) {
      console.error('❌ SQL execution failed:', error.message);
      process.exit(1);
    }

    if (isQuery && data) {
      console.log('✅ Query results:');
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log('✅ Operation completed successfully!');
    }
  } catch (err: any) {
    console.error('❌ Unexpected error:', err.message);
    process.exit(1);
  }
}

runMigration();
