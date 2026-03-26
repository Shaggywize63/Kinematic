import { supabaseAdmin } from './src/lib/supabase';

async function runMigration() {
  const sql = `
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'form_submissions' AND column_name = 'outlet_id') THEN
            ALTER TABLE form_submissions ADD COLUMN outlet_id UUID REFERENCES builder_outlets(id);
        END IF;
    END $$;
  `;
  
  const { error } = await supabaseAdmin.rpc('exec_sql', { sql_query: sql });
  
  if (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } else {
    console.log('Migration successful');
  }
}

runMigration();
