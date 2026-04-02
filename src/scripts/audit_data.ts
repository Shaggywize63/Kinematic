
import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import path from 'path'

// Load backend env
dotenv.config({ path: path.join(__dirname, '../.env') })

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function audit() {
  console.log("--- STARTING DATA AUDIT ---")
  
  const { data: clients, error: cerr } = await supabase
    .from('clients')
    .select('*')
  
  if (cerr) {
    console.error("Error fetching clients:", cerr)
    return
  }

  console.log(`Found ${clients.length} total clients.`)
  clients.forEach(c => {
    console.log(`[CLIENT] ID: ${c.id}, Name: ${c.name}, Org: ${c.org_id}, Active: ${c.is_active}`)
  })

  const { data: cities, error: cterr } = await supabase
    .from('cities')
    .select('*')
  
  if (cterr) {
    console.error("Error fetching cities:", cterr)
    return
  }

  console.log(`\nFound ${cities.length} cities.`)
  cities.forEach(c => {
    console.log(`[CITY] Name: ${c.name}, ClientID: ${c.client_id}, Org: ${c.org_id}`)
  })
  
  console.log("\n--- AUDIT COMPLETE ---")
}

audit()
