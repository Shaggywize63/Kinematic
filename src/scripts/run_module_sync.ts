import { supabaseAdmin } from '../lib/supabase';
import * as fs from 'fs';
import * as path from 'path';

async function runSync() {
  console.log('Starting module synchronization (Upsert)...');
  
  const modules = [
    { id: 'analytics',       name: 'Analytics & Tracking' },
    { id: 'live_tracking',   name: 'Live Tracking' },
    { id: 'broadcast',       name: 'Broadcasts' },
    { id: 'attendance',      name: 'Attendance' },
    { id: 'orders',          name: 'Route Planning (Orders)' },
    { id: 'work_activities', name: 'Work Activities' },
    { id: 'users',           name: 'Manpower Management' },
    { id: 'hr',              name: 'HR & Payroll' },
    { id: 'visit_logs',      name: 'Visit Logs' },
    { id: 'inventory',       name: 'Warehouse & Inventory' },
    { id: 'skus',            name: "SKU's Management" },
    { id: 'assets',          name: 'Asset Management' },
    { id: 'grievances',      name: 'Grievance Management' },
    { id: 'form_builder',    name: 'Form Builder' },
    { id: 'cities',          name: 'City Management' },
    { id: 'zones',           name: 'Zone Management' },
    { id: 'stores',          name: 'Outlet Management' },
    { id: 'activities',      name: 'Activity Management' },
    { id: 'clients',         name: 'Client Management' },
    { id: 'settings',        name: 'System Settings' }
  ];

  try {
    const { error } = await supabaseAdmin.from('modules').upsert(modules, { onConflict: 'id' });
    
    if (error) {
      console.error('Synchronization failed:', error.message);
      process.exit(1);
    }
    
    console.log('Module synchronization complete.');
  } catch (err: any) {
    console.error('Error running sync:', err.message);
    process.exit(1);
  }
}

runSync();
