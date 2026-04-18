import { isoDate } from './index';

export const DEMO_ORG_ID = 'demo-org-999';
export const DEMO_USER_ID = 'demo-user-id';

export const isDemo = (user?: { org_id?: string }) => user?.org_id === DEMO_ORG_ID;

export const getMockSummary = (date: string) => ({
  date,
  kpis: {
    total_tff: 1248,
    total_engagements: 1560,
    tff_rate: 80,
    avg_attendance: 92,
    total_leaves: 4,
    total_days_worked: 26,
    total_hours_worked: 1840.5,
    active_sos: 0,
    open_grievances: 2,
  },
  top_performers: [
    { name: 'Arjun Sharma', zone: 'Bangalore North', tff: 142 },
    { name: 'Priya Patel', zone: 'Mumbai West', tff: 138 },
    { name: 'Rahul Verma', zone: 'Delhi Central', tff: 135 },
    { name: 'Sneha Rao', zone: 'Hyderabad South', tff: 128 },
    { name: 'Amit Singh', zone: 'Pune East', tff: 122 }
  ],
  zone_performance: [
    { zone: 'Bangalore', tff: 450, target: 500 },
    { zone: 'Mumbai', tff: 380, target: 400 },
    { zone: 'Delhi', tff: 320, target: 350 },
    { zone: 'Chennai', tff: 280, target: 300 }
  ],
  total_executives: 145,
});

export const getMockTrends = () => {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const dateStr = isoDate(d);
    return {
      date: dateStr,
      tff: 120 + Math.floor(Math.random() * 40),
      engagements: 150 + Math.floor(Math.random() * 50),
      tff_rate: 80,
      label: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      short_label: d.toLocaleDateString('en-IN', { weekday: 'short' }).substring(0, 1)
    };
  });
  return days;
};

export const getMockFeed = () => [
  { id: '1', time: new Date().toISOString(), description: 'Arjun Sharma submitted TFF ✓', meta: { activity: 'Product Launch', outlet: 'Reliance Fresh' } },
  { id: '2', time: new Date(Date.now() - 3600000).toISOString(), description: 'Priya Patel checked in', meta: { activity: 'Attendance', outlet: 'Big Bazaar' } },
  { id: '3', time: new Date(Date.now() - 7200000).toISOString(), description: 'Rahul Verma submitted Form', meta: { activity: 'Price Audit', outlet: 'Star Market' } },
  { id: '4', time: new Date(Date.now() - 10800000).toISOString(), description: 'Sneha Rao submitted TFF ✓', meta: { activity: 'Store Branding', outlet: 'Metro Cash' } },
  { id: '5', time: new Date(Date.now() - 14400000).toISOString(), description: 'Amit Singh checked out', meta: { activity: 'Attendance', outlet: 'Spencer\'s' } }
];

export const getMockHeatmap = () => {
  const daysArr = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const rows = daysArr.map(day => ({
    day,
    hours: Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      count: (h >= 10 && h <= 18) ? Math.floor(Math.random() * 20) + 5 : Math.floor(Math.random() * 5)
    })),
    total: 150 + Math.floor(Math.random() * 100)
  }));
  return {
    rows,
    summary: {
      peak_hour: '11:00',
      peak_hour_count: 45,
      peak_day: 'Wed',
      peak_day_count: 240,
      total_contacts: 1560
    }
  };
};

export const getMockLocations = (today: string) => ({
  date: today,
  summary: { total: 15, active: 12, checked_out: 2, absent: 1 },
  locations: [
    { id: 'fe1', name: 'Arjun Sharma', role: 'executive', battery_percentage: 85, status: 'active', lat: 12.9352, lng: 77.6245, address: 'Koramangala 4th Block' },
    { id: 'fe2', name: 'Priya Patel', role: 'executive', battery_percentage: 42, status: 'active', lat: 12.9279, lng: 77.6271, address: 'Koramangala 5th Block' },
    { id: 'fe3', name: 'Rahul Verma', role: 'executive', battery_percentage: 91, status: 'on_break', lat: 12.9314, lng: 77.6189, address: 'Indiranagar Main Rd' },
    { id: 'fe4', name: 'Sneha Rao', role: 'executive', battery_percentage: 12, status: 'active', lat: 12.9401, lng: 77.6201, address: 'Sony World Signal' },
    { id: 'fe5', name: 'Amit Singh', role: 'senior_executive', battery_percentage: 77, status: 'checked_out', lat: 12.9378, lng: 77.6305, address: 'HSR Layout Sector 2' }
  ]
});

export const getMockAttendanceToday = (today: string) => ({
  date: today,
  summary: { total: 145, present: 132, on_break: 5, checked_out: 4, absent: 4, regularised: 0 },
  executives: [
    { id: 'fe1', name: 'Arjun Sharma', display_status: 'present', checkin_at: `${today}T09:15:00Z`, total_hours: 4.5 },
    { id: 'fe2', name: 'Priya Patel', display_status: 'present', checkin_at: `${today}T09:30:00Z`, total_hours: 4.2 },
    { id: 'fe3', name: 'Rahul Verma', display_status: 'on_break', checkin_at: `${today}T09:00:00Z`, total_hours: 4.8 },
    { id: 'fe4', name: 'Sneha Rao', display_status: 'present', checkin_at: `${today}T10:00:00Z`, total_hours: 3.7 },
    { id: 'fe5', name: 'Amit Singh', display_status: 'checked_out', checkin_at: `${today}T08:45:00Z`, checkout_at: `${today}T13:00:00Z`, total_hours: 4.25 }
  ]
});

export const getMockVisitLogs = (today: string) => [
  { id: 'v1', visitor_name: 'Manish Kumar', visitor_role: 'Operations Manager', executive: { name: 'Arjun Sharma' }, rating: 'Excellent', remarks: 'Good shelf discipline. Product display is perfect.', visited_at: `${today}T11:20:00Z`, visit_response: 'Thanks, working on the inventory update now.' },
  { id: 'v2', visitor_name: 'Anita Desai', visitor_role: 'Supervisor', executive: { name: 'Priya Patel' }, rating: 'Good', remarks: 'Store compliance met. Need focus on SKU expansion.', visited_at: `${today}T10:45:00Z`, visit_response: null },
  { id: 'v3', visitor_name: 'Manish Kumar', visitor_role: 'Operations Manager', executive: { name: 'Rahul Verma' }, rating: 'Average', remarks: 'Uniform missing. Grooming standards need improvement.', visited_at: `${today}T09:30:00Z`, visit_response: 'Noted. Will ensure from tomorrow.' }
];

export const getMockSubmissions = (today: string) => ({
  total: 1560,
  data: [
    { id: 's1', submitted_at: `${today}T12:05:00Z`, is_converted: true, outlet_name: 'Reliance Fresh - Koramangala', users: { name: 'Arjun Sharma' }, form_templates: { name: 'Product Audit' }, activities: { name: 'Store Visit' } },
    { id: 's2', submitted_at: `${today}T11:50:00Z`, is_converted: false, outlet_name: 'Big Bazaar - Indiranagar', users: { name: 'Priya Patel' }, form_templates: { name: 'Merchandising' }, activities: { name: 'Merchandising' } },
    { id: 's3', submitted_at: `${today}T11:30:00Z`, is_converted: true, outlet_name: 'Star Market - HSR', users: { name: 'Rahul Verma' }, form_templates: { name: 'Product Audit' }, activities: { name: 'Store Visit' } },
    { id: 's4', submitted_at: `${today}T11:15:00Z`, is_converted: true, outlet_name: 'Metro Cash & Carry', users: { name: 'Sneha Rao' }, form_templates: { name: 'Compliance Checklist' }, activities: { name: 'Compliance' } },
    { id: 's5', submitted_at: `${today}T10:55:00Z`, is_converted: false, outlet_name: 'Reliance Smart - Jayanagar', users: { name: 'Amit Singh' }, form_templates: { name: 'Stock Reporting' }, activities: { name: 'Inventory' } }
  ]
});

export const getMockSubmissionDetails = (id: string) => ({
  id,
  submitted_at: new Date().toISOString(),
  is_converted: true,
  outlet_name: 'Reliance Fresh - Koramangala',
  users: { name: 'Arjun Sharma', employee_id: 'KIN-001' },
  form_templates: { name: 'Product Audit' },
  activities: { name: 'Store Visit' },
  form_responses: [
    { field_key: 'shelf_status', form_fields: { label: 'Shelf Condition', field_type: 'text' }, value_text: 'Clean and Organized' },
    { field_key: 'stock_available', form_fields: { label: 'Stock Available', field_type: 'yes_no' }, value_bool: true },
    { field_key: 'store_photo', form_fields: { label: 'Store Front Photo', field_type: 'camera' }, photo_url: 'https://images.unsplash.com/photo-1534723452862-4c874018d66d?auto=format&fit=crop&w=800&q=80' },
    { field_key: 'manager_sign', form_fields: { label: 'Manager Signature', field_type: 'signature' }, value_text: 'https://upload.wikimedia.org/wikipedia/commons/3/3a/Jon_Snow_Signature.png' }
  ]
});

export const getMockSOS = () => [
  { id: 'sos1', created_at: new Date().toISOString(), status: 'active', remarks: 'Accident reported near Indiranagar signal.', users: { name: 'Arjun Sharma' }, latitude: 12.9716, longitude: 77.5946 },
  { id: 'sos2', created_at: new Date(Date.now() - 86400000).toISOString(), status: 'resolved', remarks: 'Medical emergency - resolved in 15 mins.', users: { name: 'Priya Patel' }, resolution: 'Ambulance called, family informed.' }
];

export const getMockGrievances = () => [
  { id: 'g1', reference_no: 'GRV-102', category: 'Harassment', status: 'submitted', description: 'Rude behavior from store manager.', created_at: new Date().toISOString() },
  { id: 'g2', reference_no: 'GRV-098', category: 'Payment', status: 'resolved', description: 'Travel allowance not credited for March.', resolution: 'Credited in April cycle.' }
];

export const getMockBroadcasts = () => [
  { 
    id: 'b1', 
    question: 'How do you like the new Kinematic 2.0 interface?', 
    options: [{ label: 'Love it!', value: 'love' }, { label: 'It is OK', value: 'ok' }, { label: 'Needs work', value: 'work' }],
    status: 'active',
    is_urgent: true,
    response_count: 156,
    created_at: new Date().toISOString(),
    tally: [
      { label: 'Love it!', count: 120 },
      { label: 'It is OK', count: 30 },
      { label: 'Needs work', count: 6 }
    ],
    responses: [
      { user_name: 'Arjun Sharma', employee_id: 'KIN-001', selected_label: 'Love it!', is_correct: null, answered_at: new Date().toISOString() },
      { user_name: 'Priya Patel', employee_id: 'KIN-002', selected_label: 'Love it!', is_correct: null, answered_at: new Date().toISOString() }
    ]
  }
];

// --- Metadata Mocks ---

export const getMockCities = () => [
  { id: 'c1', name: 'Bangalore', state: 'Karnataka', is_active: true, created_at: new Date().toISOString() },
  { id: 'c2', name: 'Mumbai', state: 'Maharashtra', is_active: true, created_at: new Date().toISOString() },
  { id: 'c3', name: 'Delhi', state: 'Delhi', is_active: true, created_at: new Date().toISOString() },
  { id: 'c4', name: 'Hyderabad', state: 'Telangana', is_active: true, created_at: new Date().toISOString() },
  { id: 'c5', name: 'Pune', state: 'Maharashtra', is_active: true, created_at: new Date().toISOString() }
];

export const getMockZones = () => [
  { id: 'z1', name: 'Koramangala 4th Block', city: 'Bangalore', is_active: true, created_at: new Date().toISOString() },
  { id: 'z2', name: 'Andheri East', city: 'Mumbai', is_active: true, created_at: new Date().toISOString() },
  { id: 'z3', name: 'Cannaught Place', city: 'Delhi', is_active: true, created_at: new Date().toISOString() },
  { id: 'z4', name: 'Banjara Hills', city: 'Hyderabad', is_active: true, created_at: new Date().toISOString() },
  { id: 'z5', name: 'Viman Nagar', city: 'Pune', is_active: true, created_at: new Date().toISOString() }
];

export const getMockClients = () => [
  { id: 'cl1', name: 'Hindustan Unilever', is_active: true },
  { id: 'cl2', name: 'ITC Limited', is_active: true },
  { id: 'cl3', name: 'Nestle India', is_active: true }
];

export const getMockStores = () => [
  { id: 'st1', name: 'Reliance Fresh - Koramangala', city_id: 'c1', zone_id: 'z1', address: '123 Main Rd', is_active: true, cities: { name: 'Bangalore' }, zones: { name: 'Koramangala 4th Block' } },
  { id: 'st2', name: 'Big Bazaar - Indiranagar', city_id: 'c1', zone_id: 'z1', address: '456 Side Rd', is_active: true, cities: { name: 'Bangalore' }, zones: { name: 'Indiranagar Main Rd' } }
];

export const getMockActivities = () => [
  { id: 'a1', name: 'Store Visit', type: 'visit', is_active: true },
  { id: 'a2', name: 'Product Audit', type: 'form', is_active: true },
  { id: 'a3', name: 'Merchandising', type: 'form', is_active: true },
  { id: 'a4', name: 'Compliance', type: 'form', is_active: true }
];

export const getMockSecurityAlerts = (today: string) => [
  { id: 'sa1', type: 'MOCK_LOCATION', action: 'ATTENDANCE', lat: 12.9352, lng: 77.6245, created_at: `${today}T09:16:12Z`, user: { name: 'Arjun Sharma', employee_id: 'KIN-001' } },
  { id: 'sa2', type: 'VPN_DETECTED', action: 'FORM_SUBMISSION', lat: 12.9279, lng: 77.6271, created_at: `${today}T11:50:45Z`, user: { name: 'Priya Patel', employee_id: 'KIN-002' } },
];

export const getMockDeviceInfo = () => [
  { id: 'd1', user_id: 'fe1', device_model: 'Pixel 7 Pro', device_brand: 'Google', os_version: '14', battery_percentage: 85, last_updated: new Date().toISOString() },
  { id: 'd2', user_id: 'fe2', device_model: 'Galaxy S23', device_brand: 'Samsung', os_version: '13', battery_percentage: 42, last_updated: new Date().toISOString() },
];

// --- MOBILE APP MOCKS ---

export const getMockFormTemplates = () => [
  {
    id: 'f1',
    activity_id: 'a1',
    name: 'Daily Store Audit',
    description: 'General store hygiene and stock audit',
    requires_photo: true,
    requires_gps: true,
    form_fields: [
      { id: 'q1', label: 'Store Cleanliness', field_key: 'cleanliness', field_type: 'select', options: ['Excellent', 'Good', 'Average', 'Poor'], is_required: true, sort_order: 1 },
      { id: 'q2', label: 'Stock Available', field_key: 'stock', field_type: 'number', is_required: true, sort_order: 2 },
      { id: 'q3', label: 'Display Setup Photo', field_key: 'photo', field_type: 'camera', is_required: true, sort_order: 3 }
    ]
  },
  {
    id: 'f2',
    activity_id: 'a2',
    name: 'Competitor Tracking',
    description: 'Log competitor pricing and promos',
    requires_photo: false,
    requires_gps: true,
    form_fields: [
      { id: 'q4', label: 'Competitor Name', field_key: 'comp_name', field_type: 'text', placeholder: 'Brand name', is_required: true, sort_order: 1 },
      { id: 'q5', label: 'Price (INR)', field_key: 'price', field_type: 'number', is_required: true, sort_order: 2 }
    ]
  }
];

export const getMockRoutePlans = (today: string) => [
  {
    id: 'rp1',
    user_id: 'demo-user-id',
    fe_name: 'Demo Admin',
    plan_date: today,
    status: 'pending',
    total_outlets: 5,
    visited_outlets: 2,
    outlets: [
      { id: 'o1', name: 'Reliance Fresh - Koramangala', visit_order: 1, status: 'visited', address: '123 Koramangala', activities: [{ id: 'a1', name: 'Store Visit', status: 'visited' }] },
      { id: 'o2', name: 'Big Bazaar - Indiranagar', visit_order: 2, status: 'visited', address: '456 Indiranagar', activities: [{ id: 'a1', name: 'Store Visit', status: 'visited' }] },
      { id: 'o3', name: 'Star Market - HSR', visit_order: 3, status: 'pending', address: '789 HSR Layout', activities: [{ id: 'a1', name: 'Store Visit', status: 'pending' }] },
      { id: 'o4', name: 'Metro Cash & Carry', visit_order: 4, status: 'pending', address: '101 Whitefield', activities: [{ id: 'a1', name: 'Store Visit', status: 'pending' }] },
      { id: 'o5', name: 'Spencer\'s - MG Road', visit_order: 5, status: 'pending', address: '202 MG Road', activities: [{ id: 'a1', name: 'Store Visit', status: 'pending' }] }
    ]
  }
];

export const getMockMyRoutePlan = (today: string) => ({
  ...getMockRoutePlans(today)[0],
  id: 'unified-' + today,
  multi_plan_ids: ['rp1']
});

export const getMockActivityMapping = () => [
  { id: 'a1', name: 'Store Visit', type: 'visit', description: 'Regular store check-in' },
  { id: 'a2', name: 'Merchandising', type: 'form', description: 'Setup display and take photos' },
  { id: 'a3', name: 'Audit', type: 'audit', description: 'Inventory verify' }
];

export const getMockAttendanceHistory = (today: string) => [
  { date: today, status: 'checked_in', checkin_at: `${today}T09:00:00Z`, checkout_at: null, total_hours: 4.5 },
  { date: '2024-04-17', status: 'checked_out', checkin_at: '2024-04-17T09:15:00Z', checkout_at: '2024-04-17T18:30:00Z', total_hours: 9.25 },
  { date: '2024-04-16', status: 'checked_out', checkin_at: '2024-04-16T08:45:00Z', checkout_at: '2024-04-16T17:45:00Z', total_hours: 9.0 }
];

export const getMockCityPerformance = () => [
  { city: 'Bangalore', zones: 12, active_fes: 45, checkins: 850, engagements: 1240, tff: 450, tff_rate: 36, unique_outlets: 380, avg_hours: 8.2, lat: 12.9716, lng: 77.5946 },
  { city: 'Mumbai', zones: 18, active_fes: 38, checkins: 720, engagements: 980, tff: 380, tff_rate: 38, unique_outlets: 320, avg_hours: 7.9, lat: 19.0760, lng: 72.8777 },
  { city: 'Delhi', zones: 15, active_fes: 32, checkins: 640, engagements: 850, tff: 320, tff_rate: 37, unique_outlets: 280, avg_hours: 8.5, lat: 28.6139, lng: 77.2090 },
  { city: 'Hyderabad', zones: 10, active_fes: 28, checkins: 510, engagements: 620, tff: 280, tff_rate: 45, unique_outlets: 240, avg_hours: 8.0, lat: 17.3850, lng: 78.4867 }
];

export const getMockOutletCoverage = () => ({
  summary: { total_outlets: 1240, total_checkins: 4500, total_tff: 1560 },
  cities: [
    { city: 'Bangalore', total_outlets: 450, covered: 380, percentage: 84 },
    { city: 'Mumbai', total_outlets: 380, covered: 320, percentage: 84 },
    { city: 'Delhi', total_outlets: 320, covered: 280, percentage: 87 }
  ],
  outlets: [
    { name: 'Reliance Fresh - Koramangala', checkins: 12, tff: 8, city: 'Bangalore', tff_rate: 66 },
    { name: 'Big Bazaar - Lower Parel', checkins: 15, tff: 10, city: 'Mumbai', tff_rate: 66 },
    { name: 'Star Market - Indiranagar', checkins: 10, tff: 7, city: 'Bangalore', tff_rate: 70 },
    { name: 'Spar - HSR Layout', checkins: 8, tff: 5, city: 'Bangalore', tff_rate: 62 },
    { name: 'More - Powai', checkins: 14, tff: 9, city: 'Mumbai', tff_rate: 64 }
  ]
});

export const getMockMobileHome = () => ({
  attendance: { status: 'checked_in', time: '09:00 AM' },
  today_plan: { total: 5, visited: 2, pending: 3 },
  announcements: [
    { title: 'New Product Launch', body: 'Introducing the new Organic Range tomorrow.' },
    { title: 'Holiday Notice', body: 'Stores will remain closed on May 1st.' }
  ],
  kpis: {
    monthly_tff: 124,
    monthly_earnings: 15400,
    target_pct: 85
  }
});

export const getMockWMSInventory = () => [
  { id: 'p1', name: 'Product A', sku: 'SKU-001', category: 'FMCG', stock_level: 450, warehouse: 'Bangalore-Central' },
  { id: 'p2', name: 'Product B', sku: 'SKU-002', category: 'Electronics', stock_level: 120, warehouse: 'Bangalore-Central' },
  { id: 'p3', name: 'Product C', sku: 'SKU-003', category: 'Apparel', stock_level: 890, warehouse: 'Mumbai-Hub' }
];

export const getMockWarehouses = () => [
  { id: 'w1', name: 'Bangalore-Central', city: 'Bangalore', type: 'Distribution Center', capacity: '90%' },
  { id: 'w2', name: 'Mumbai-Hub', city: 'Mumbai', type: 'Regional Warehouse', capacity: '75%' }
];

export const getMockStockAllocations = () => [
  { 
    id: 'sa1', 
    date: isoDate(new Date()), 
    status: 'pending', 
    users: { name: 'Arjun Sharma' },
    stock_items: [
      { id: 'si1', product_name: 'Product A', quantity_allocated: 100, status: 'pending' },
      { id: 'si2', product_name: 'Product B', quantity_allocated: 50, status: 'pending' }
    ]
  }
];

export const getMockWMSSummary = () => ({
  warehouses: getMockWarehouses().map(w => ({ ...w, is_active: true, stats: { inbound: 1200, outbound: 800, total_moves: 45 } })),
  total_warehouses: 2,
  active_warehouses: 2,
  total_skus: 150,
  total_assets: 45,
  total_movements_30d: 850
});

export const getMockLeaderboard = () => [
  { rank: 1, users: { name: 'Arjun Sharma', employee_id: 'KIN-001' }, overall_score: 980, is_me: false },
  { rank: 2, users: { name: 'Demo Admin', employee_id: 'DEMO-001' }, overall_score: 945, is_me: true },
  { rank: 3, users: { name: 'Priya Patel', employee_id: 'KIN-002' }, overall_score: 920, is_me: false },
  { rank: 4, users: { name: 'Rahul Verma', employee_id: 'KIN-003' }, overall_score: 890, is_me: false },
  { rank: 5, users: { name: 'Sneha Rao', employee_id: 'KIN-004' }, overall_score: 860, is_me: false }
];

