
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

async function auditAllAuth() {
  console.log('--- EXHAUSTIVE AUTH AUDIT ---');
  let page = 1;
  let allUsers: any[] = [];
  
  while (true) {
    const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers({
      page: page,
      perPage: 100
    });
    
    if (error) {
      console.error('Error fetching auth users:', error.message);
      break;
    }
    
    if (!users || users.length === 0) break;
    
    allUsers = allUsers.concat(users);
    page++;
  }

  console.log(`Total Auth Users: ${allUsers.length}`);
  const ghosts = allUsers.filter(u => 
    JSON.stringify(u).includes('DIAGNOSTIC') || 
    JSON.stringify(u).includes('JOINED') ||
    u.email?.includes('kinematic.app') && u.email !== 'sagar@horizontechstudio.com'
  );

  if (ghosts.length > 0) {
    console.log(`!!! FOUND ${ghosts.length} GHOSTS:`);
    ghosts.forEach(u => {
      console.log(`- ID: ${u.id} | Email: ${u.email} | Meta: ${JSON.stringify(u.user_metadata)}`);
    });
  } else {
    console.log('No ghosts found in Auth metadata.');
  }
}

auditAllAuth();
