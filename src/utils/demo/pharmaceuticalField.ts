/**
 * Pharmaceutical-vertical field-force demo fixtures — Vireon Pharma India.
 *
 * Each function below mirrors the EXACT return shape of its generic twin in
 * `src/utils/demoData.ts` (same keys, same nesting, RAW payload — NOT wrapped
 * in `{ success, data }`, because the backend getMock* helpers return the bare
 * body and the route handlers wrap it). Only the content is re-themed to a
 * pharma field force: Medical Representatives (MRs) visiting HCPs
 * (Healthcare Practitioners), hospitals, and pharmacy chains; detailing,
 * sampling, CME, pharmacovigilance.
 *
 * Consumed by demoData.ts, which branches on currentDemoIndustry().
 */
import { isoDate } from '../index';

export const getMockSummary = (date: string) => ({
  date,
  kpis: {
    total_tff: 1456,
    total_engagements: 1820,
    tff_rate: 80,
    avg_attendance: 94,
    total_leaves: 3,
    total_days_worked: 26,
    total_hours_worked: 1920.5,
    active_sos: 0,
    open_grievances: 1,
  },
  top_performers: [
    { name: 'Arjun Sharma', zone: 'Bengaluru — South', tff: 158 },
    { name: 'Priya Patel',  zone: 'Mumbai — West',     tff: 152 },
    { name: 'Rahul Verma',  zone: 'Delhi — Central',   tff: 148 },
    { name: 'Sneha Rao',    zone: 'Hyderabad — South', tff: 142 },
    { name: 'Amit Singh',   zone: 'Pune — East',       tff: 136 }
  ],
  zone_performance: [
    { zone: 'Bengaluru', tff: 510, target: 540 },
    { zone: 'Mumbai',    tff: 430, target: 460 },
    { zone: 'Delhi',     tff: 360, target: 400 },
    { zone: 'Chennai',   tff: 300, target: 320 }
  ],
  total_executives: 160,
});

export const getMockTrends = () => {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const dateStr = isoDate(d);
    return {
      date: dateStr,
      tff: 140 + Math.floor(Math.random() * 45),
      engagements: 175 + Math.floor(Math.random() * 55),
      tff_rate: 80,
      label: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
      short_label: d.toLocaleDateString('en-IN', { weekday: 'short' }).substring(0, 1)
    };
  });
  return days;
};

export const getMockFeed = () => [
  {
    id: '1',
    outlet_name: 'Dr. Anil Mehta (Endocrinology) – Sunrise Andheri',
    submitted_at: new Date().toISOString(),
    is_converted: true,
    user: { name: 'Arjun Sharma', zones: { city: 'Mumbai', name: 'West' } },
    description: 'Arjun Sharma submitted HCP Detailing Form ✓',
    form_name: 'HCP Detailing Form'
  },
  {
    id: '2',
    outlet_name: 'Meridian Hospital — Bengaluru',
    submitted_at: new Date(Date.now() - 3600000).toISOString(),
    is_converted: false,
    user: { name: 'Priya Patel', zones: { city: 'Bengaluru', name: 'South' } },
    description: 'Priya Patel checked in at Meridian',
    form_name: 'Attendance'
  },
  {
    id: '3',
    outlet_name: 'Dr. Neha Gupta (Endocrinology) – AIIMS Delhi',
    submitted_at: new Date(Date.now() - 7200000).toISOString(),
    is_converted: true,
    user: { name: 'Rahul Verma', zones: { city: 'Delhi', name: 'Central' } },
    description: 'Rahul Verma submitted Sample Drop Acknowledgement',
    form_name: 'Sample Drop Acknowledgement'
  }
];

export const getMockLocations = (today: string) => ({
  date: today,
  summary: { total: 15, active: 12, checked_out: 2, absent: 1 },
  locations: [
    { id: 'fe1', name: 'Arjun Sharma', role: 'executive',        battery_percentage: 88, status: 'active',      lat: 12.9352, lng: 77.6245, address: 'Koramangala, Meridian Hospital' },
    { id: 'fe2', name: 'Priya Patel',  role: 'executive',        battery_percentage: 46, status: 'active',      lat: 12.9279, lng: 77.6271, address: 'Indiranagar, Sunrise Clinics' },
    { id: 'fe3', name: 'Rahul Verma',  role: 'executive',        battery_percentage: 91, status: 'on_break',    lat: 12.9314, lng: 77.6189, address: '100 Ft Road, Crescent' },
    { id: 'fe4', name: 'Sneha Rao',    role: 'executive',        battery_percentage: 18, status: 'active',      lat: 12.9401, lng: 77.6201, address: 'HSR Layout, WellCare' },
    { id: 'fe5', name: 'Amit Singh',   role: 'senior_executive', battery_percentage: 79, status: 'checked_out', lat: 12.9378, lng: 77.6305, address: 'BTM, Sunrise Pharmacy' }
  ]
});

export const getMockAttendanceToday = (today: string) => ({
  date: today,
  summary: { total: 160, present: 148, on_break: 4, checked_out: 5, absent: 3, regularised: 0 },
  executives: [
    { id: 'att-1', user_id: 'fe1', status: 'checked_in',  date: today, checkin_at: `${today}T09:15:00Z`, total_hours: 4.5,
      users: { name: 'Arjun Sharma', employee_id: 'VRN-001', role: 'executive',  zones: { name: 'Bengaluru — South' } } },
    { id: 'att-2', user_id: 'fe2', status: 'checked_out', date: today, checkin_at: `${today}T09:30:00Z`, checkout_at: `${today}T18:30:00Z`, total_hours: 9.0,
      users: { name: 'Priya Patel',  employee_id: 'VRN-002', role: 'executive',  zones: { name: 'Mumbai — West' } } },
    { id: 'att-3', user_id: 'fe3', status: 'checked_in',  date: today, checkin_at: `${today}T09:00:00Z`, total_hours: 4.8,
      users: { name: 'Rahul Verma',  employee_id: 'VRN-003', role: 'executive',  zones: { name: 'Delhi — Central' } } },
    { id: 'att-4', user_id: 'fe4', status: 'checked_in',  date: today, checkin_at: `${today}T10:00:00Z`, total_hours: 3.7,
      users: { name: 'Sneha Rao',    employee_id: 'VRN-004', role: 'supervisor', zones: { name: 'Hyderabad — South' } } },
    { id: 'att-5', user_id: 'fe5', status: 'checked_out', date: today, checkin_at: `${today}T08:45:00Z`, checkout_at: `${today}T17:45:00Z`, total_hours: 9.0,
      users: { name: 'Amit Singh',   employee_id: 'VRN-005', role: 'executive',  zones: { name: 'Pune — East' } } }
  ]
});

export const getMockSubmissions = (today: string) => {
  const yesterday = new Date(new Date(today).getTime() - 86400000).toISOString().split('T')[0];

  const pics = [
    'https://images.unsplash.com/photo-1576091160550-2173dba999ef?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1583912267550-aae0d44dab4a?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1584467735815-f778f274e296?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1530026405186-ed1f139313f8?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1631815589968-fdb09a223b1e?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1610385564822-39c6a8c6f4f0?auto=format&fit=crop&w=800&q=80',
  ];

  const data = [
    { id: 's1', user_id: 'fe1', submitted_at: `${today}T12:05:00Z`, outlet_name: 'Dr. Anil Mehta (Endocrinology) – Sunrise Andheri', users: { name: 'Arjun Sharma', employee_id: 'VRN-001' }, activities: { name: 'Glucanova Detailing' }, photo_url: pics[0] },
    { id: 's2', user_id: 'fe2', submitted_at: `${today}T11:50:00Z`, outlet_name: 'Meridian Hospital — Bengaluru',                  users: { name: 'Priya Patel',  employee_id: 'VRN-002' }, activities: { name: 'Sampling' },           photo_url: pics[1] },
    { id: 's3', user_id: 'fe3', submitted_at: `${today}T11:30:00Z`, outlet_name: 'Dr. Neha Gupta (Endocrinology) – AIIMS Delhi',  users: { name: 'Rahul Verma',  employee_id: 'VRN-003' }, activities: { name: 'Diabextra Detailing' }, photo_url: pics[2] },
    { id: 's4', user_id: 'fe4', submitted_at: `${today}T10:15:00Z`, outlet_name: 'Sunrise Pharmacy — Greams Road',                  users: { name: 'Sneha Rao',    employee_id: 'VRN-004' }, activities: { name: 'Pharmacy Audit' },     photo_url: pics[3] },
    { id: 's5', user_id: 'fe5', submitted_at: `${today}T09:45:00Z`, outlet_name: 'Dr. Karan Verma (Neurology) – Northgate Delhi',    users: { name: 'Amit Singh',   employee_id: 'VRN-005' }, activities: { name: 'Sampling' },           photo_url: pics[4] },
    { id: 's6', user_id: 'fe1', submitted_at: `${yesterday}T16:05:00Z`, outlet_name: 'Dr. R. K. Tandon — Metropolis Cancer Centre',    users: { name: 'Arjun Sharma', employee_id: 'VRN-001' }, activities: { name: 'CME Outreach' },        photo_url: pics[5] },
    { id: 's7', user_id: 'fe2', submitted_at: `${yesterday}T14:40:00Z`, outlet_name: 'Sunrise Pharmacy — Linking Road',             users: { name: 'Priya Patel',  employee_id: 'VRN-002' }, activities: { name: 'Pharmacy Audit' },     photo_url: pics[0] },
    { id: 's8', user_id: 'fe3', submitted_at: `${yesterday}T10:30:00Z`, outlet_name: 'Dr. Manish Khanna (Oncology) – Lakeview',    users: { name: 'Rahul Verma',  employee_id: 'VRN-003' }, activities: { name: 'Oncevia Detailing' }, photo_url: pics[1] },
    { id: 's9', user_id: 'fe4', submitted_at: `${yesterday}T09:15:00Z`, outlet_name: 'Dr. Kavita Iyer (Oncology) – Meridian',        users: { name: 'Sneha Rao',    employee_id: 'VRN-004' }, activities: { name: 'CME Outreach' },        photo_url: pics[2] },
    { id: 's10',user_id: 'fe5', submitted_at: `${yesterday}T13:25:00Z`, outlet_name: 'Dr. Suresh Kumar (Diabetology) – Emerald Clinic', users: { name: 'Amit Singh',   employee_id: 'VRN-005' }, activities: { name: 'Glucanova Detailing' }, photo_url: pics[3] },
  ];

  return {
    total: data.length,
    data: data.map(sub => ({
      ...sub,
      check_in_at: sub.submitted_at,
      check_out_at: sub.submitted_at,
      check_in_gps: '12.9716,77.5946',
      check_out_gps: '12.9717,77.5947',
      address: 'Bandra Kurla Complex, Mumbai, MH, 400051',
      form_responses: [
        { builder_questions: { label: 'HCP Photo / Signature', qtype: 'camera' }, value_text: sub.photo_url },
        { builder_questions: { label: 'Key Message Delivered', qtype: 'text' },   value_text: 'Glucanova — A1c reduction + weight loss' },
        { builder_questions: { label: 'Trial Rx Intent (0-10)', qtype: 'number' }, value_number: 8 }
      ]
    }))
  };
};

export const getMockSubmissionDetails = (id: string) => ({
  id,
  submitted_at: new Date().toISOString(),
  is_converted: true,
  outlet_name: 'Dr. Anil Mehta (Endocrinology) – Sunrise Andheri',
  address: 'Andheri West, Mumbai',
  latitude: 19.1360, longitude: 72.8260,
  check_in_gps: '19.1360,72.8260', check_out_gps: '19.1361,72.8261',
  users: { name: 'Arjun Sharma', employee_id: 'VRN-001' },
  builder_forms: { title: 'HCP Detailing Form' },
  activities: { name: 'Glucanova Detailing' },
  answers: [
    { label: 'Specialty',                qtype: 'text',     value: 'Endocrinology' },
    { label: 'Trial Rx Intent (0-10)',   qtype: 'number',   value: 8 },
    { label: 'Sample Drop Photo',        qtype: 'camera',   value: 'https://images.unsplash.com/photo-1583912267550-aae0d44dab4a?auto=format&fit=crop&w=800&q=80' },
    { label: 'MR Selfie at Clinic',      qtype: 'camera',   value: 'https://images.unsplash.com/photo-1576091160550-2173dba999ef?auto=format&fit=crop&w=800&q=80' },
    { label: 'HCP Signature',            qtype: 'signature',value: 'https://upload.wikimedia.org/wikipedia/commons/3/3a/Jon_Snow_Signature.png' }
  ],
  form_responses: [
    { builder_questions: { label: 'Specialty' },              value_text: 'Endocrinology' },
    { builder_questions: { label: 'Trial Rx Intent (0-10)' }, value_number: 8 }
  ]
});

export const getMockVisitLogs = (today: string) => [
  { id: 'v1', user_id: 'fe1', outlet_name: 'Dr. Anil Mehta (Endocrinology) – Sunrise Andheri', check_in_at: `${today}T10:00:00Z`, check_out_at: `${today}T10:45:00Z`, duration_min: 45, status: 'completed', users: { name: 'Arjun Sharma' } },
  { id: 'v2', user_id: 'fe1', outlet_name: 'Meridian Hospital — Bengaluru',                    check_in_at: `${today}T11:20:00Z`, check_out_at: `${today}T12:05:00Z`, duration_min: 45, status: 'completed', users: { name: 'Arjun Sharma' } },
  { id: 'v3', user_id: 'fe2', outlet_name: 'Dr. Kavita Iyer (Oncology) – Meridian',            check_in_at: `${today}T09:45:00Z`, check_out_at: `${today}T10:30:00Z`, duration_min: 45, status: 'completed', users: { name: 'Priya Patel' } },
  { id: 'v4', user_id: 'fe3', outlet_name: 'Dr. Neha Gupta (Endocrinology) – AIIMS Delhi',    check_in_at: `${today}T10:15:00Z`, check_out_at: `${today}T11:00:00Z`, duration_min: 45, status: 'completed', users: { name: 'Rahul Verma' } },
  { id: 'v5', user_id: 'fe4', outlet_name: 'Sunrise Pharmacy — Greams Road',                    check_in_at: `${today}T13:40:00Z`, check_out_at: `${today}T14:30:00Z`, duration_min: 50, status: 'completed', users: { name: 'Sneha Rao' } },
];

export const getMockActivities = () => [
  { id: 'a1', name: 'HCP Detailing',  type: 'detail',     is_active: true },
  { id: 'a2', name: 'Sample Drop',    type: 'compliance', is_active: true },
  { id: 'a3', name: 'CME Outreach',   type: 'marketing',  is_active: true },
  { id: 'a4', name: 'Pharmacy Audit', type: 'audit',      is_active: true }
];

export const getMockStores = () => [
  { id: 'st1', name: 'Sunrise Hospitals — Andheri (Dr. Mehta)',  city_id: 'c2', zone_id: 'z2', address: 'Andheri West, Mumbai',           is_active: true, cities: { name: 'Mumbai' },    zones: { name: 'Mumbai — West' } },
  { id: 'st2', name: 'Meridian Hospital — Bengaluru (Dr. Iyer)', city_id: 'c1', zone_id: 'z1', address: 'HAL Old Airport Rd, Bengaluru', is_active: true, cities: { name: 'Bengaluru' }, zones: { name: 'Bengaluru — South' } }
];

export const getMockFormTemplates = () => [
  {
    id: 'f1',
    activity_id: 'a1',
    name: 'HCP Detailing Form',
    description: 'Detail visit summary, key messages and next-best action',
    requires_photo: true,
    requires_gps: true,
    form_fields: [
      { id: 'q1', label: 'Key Message Delivered',  field_key: 'key_message',    field_type: 'text',   is_required: true, sort_order: 1 },
      { id: 'q2', label: 'Trial Rx Intent (0-10)', field_key: 'rx_intent',       field_type: 'number', is_required: true, sort_order: 2 },
      { id: 'q3', label: 'MR Selfie',              field_key: 'mr_photo',        field_type: 'camera', is_required: true, sort_order: 3 }
    ]
  },
  {
    id: 'f2',
    activity_id: 'a2',
    name: 'Sample Drop Acknowledgement',
    description: 'Capture HCP signature for samples handed over',
    requires_photo: true,
    requires_gps: true,
    form_fields: [
      { id: 'q4', label: 'Product Sample',  field_key: 'product', field_type: 'select', options: ['Glucanova', 'Diabextra', 'Oncevia', 'Rheumolex', 'Migranova'], is_required: true, sort_order: 1 },
      { id: 'q5', label: 'HCP Signature',   field_key: 'hcp_sig', field_type: 'signature', is_required: true, sort_order: 2 }
    ]
  }
];

export const getMockRoutePlans = (today: string) => [
  {
    id: 'rp1',
    user_id: 'fe1',
    fe_name: 'Arjun Sharma',
    fe_employee_id: 'VRN-001',
    plan_date: today,
    status: 'partial',
    total_outlets: 5,
    visited_outlets: 2,
    missed_outlets: 0,
    completion_pct: 40,
    zone_name: 'Mumbai — West',
    city_name: 'Mumbai',
    vehicle_type: '2w_petrol',
    emission_factor_kg_per_km: 0.072,
    total_distance_km: 18.4,
    actual_distance_km: 8.2,
    co2_kg_planned: 1.32,
    co2_kg_actual: 0.59,
    outlets: [
      { id: 'o1', store_id: 'st1', store_name: 'Sunrise Hospitals — Andheri (Dr. Mehta)',  visit_order: 1, status: 'completed', store_address: 'Andheri West, Mumbai',  target_type: 'detailing',       visited_at: `${today}T10:00:00Z`, checkin_at: `${today}T10:00:00Z`, checkout_at: `${today}T10:30:00Z`, planned_duration_min: 30, actual_duration_min: 30, activities: [{ name: 'Glucanova Detailing', status: 'completed' }] },
      { id: 'o2', store_id: 'st2', store_name: 'Sunrise Pharmacy — Linking Road',          visit_order: 2, status: 'completed', store_address: 'Linking Road, Mumbai',  target_type: 'pharmacy_audit', visited_at: `${today}T11:15:00Z`, checkin_at: `${today}T11:15:00Z`, checkout_at: `${today}T11:50:00Z`, planned_duration_min: 30, actual_duration_min: 35, activities: [{ name: 'Pharmacy Audit', status: 'completed' }] },
      { id: 'o3', store_id: 'st3', store_name: 'Dr. Kavita Iyer (Oncology) – Meridian',    visit_order: 3, status: 'pending',                                         target_type: 'sampling',        planned_duration_min: 20, activities: [{ name: 'Sampling', status: 'pending' }] },
      { id: 'o4', store_id: 'st4', store_name: 'Dr. Suresh Kumar (Diabetology) – Ruby',  visit_order: 4, status: 'pending',                                         target_type: 'detailing',       planned_duration_min: 45, activities: [{ name: 'Diabextra Detailing', status: 'pending' }] },
      { id: 'o5', store_id: 'st5', store_name: 'Dr. R. K. Tandon — Metropolis Cancer Centre',        visit_order: 5, status: 'pending',                                         target_type: 'cme_invite',     planned_duration_min: 30, activities: [{ name: 'CME Outreach', status: 'pending' }] }
    ]
  }
];

export const getMockMyRoutePlan = (today: string) => ({
  ...getMockRoutePlans(today)[0],
  id: 'unified-' + today,
  multi_plan_ids: ['rp1']
});

export const getMockCityPerformance = () => [
  { city: 'Bengaluru', zones: 12, active_fes: 48, checkins: 880, engagements: 1280, tff: 510, tff_rate: 40, unique_outlets: 312, avg_hours: 8.2, lat: 12.9716, lng: 77.5946 },
  { city: 'Mumbai',    zones: 18, active_fes: 42, checkins: 780, engagements: 1050, tff: 430, tff_rate: 41, unique_outlets: 268, avg_hours: 7.9, lat: 19.0760, lng: 72.8777 },
  { city: 'Delhi',     zones: 15, active_fes: 36, checkins: 690, engagements: 920,  tff: 360, tff_rate: 39, unique_outlets: 224, avg_hours: 8.5, lat: 28.6139, lng: 77.2090 },
  { city: 'Hyderabad', zones: 10, active_fes: 30, checkins: 560, engagements: 680,  tff: 300, tff_rate: 44, unique_outlets: 200, avg_hours: 8.0, lat: 17.3850, lng: 78.4867 }
];

export const getMockOutletCoverage = () => ({
  summary: { total_outlets: 1480, total_checkins: 4820, total_tff: 1820 },
  cities: [
    { city: 'Bengaluru', total_outlets: 360, covered: 312, percentage: 87 },
    { city: 'Mumbai',    total_outlets: 310, covered: 268, percentage: 86 },
    { city: 'Delhi',     total_outlets: 260, covered: 224, percentage: 86 }
  ],
  outlets: [
    { name: 'Sunrise Hospitals — Andheri (Dr. Mehta)',           checkins: 14, tff: 10, city: 'Mumbai',    tff_rate: 71 },
    { name: 'Meridian Hospital — Bengaluru (Dr. Iyer)',          checkins: 16, tff: 12, city: 'Bengaluru', tff_rate: 75 },
    { name: 'AIIMS Delhi (Dr. Gupta)',                          checkins: 12, tff:  9, city: 'Delhi',     tff_rate: 75 },
    { name: 'Sunrise Pharmacy — Greams Road',                     checkins:  9, tff:  6, city: 'Chennai',   tff_rate: 67 },
    { name: 'Metropolis Cancer Centre — Mumbai',                     checkins: 11, tff:  8, city: 'Mumbai',    tff_rate: 73 }
  ]
});

export const getMockMobileHome = () => ({
  attendance: { status: 'checked_in', time: '09:00 AM' },
  today_plan: { total: 6, visited: 2, pending: 4 },
  announcements: [
    { title: 'Glucanova India launch sprint', body: 'Glucanova launched in India. Prioritise top-200 endo / diabetologist HCPs this cycle.' },
    { title: 'Oncevia monarchE 5yr data',   body: 'Updated 5-year DFS slides available in the eDetailer. Use for adjuvant breast cancer detailing.' }
  ],
  kpis: {
    monthly_tff: 142,
    monthly_earnings: 19400,
    target_pct: 88
  }
});

export const getMockUsers = () => [
  { id: 'fe1', name: 'Arjun Sharma', employee_id: 'VRN-001', role: 'executive',  city: 'Bengaluru', is_active: true, zones: { name: 'Bengaluru — South' } },
  { id: 'fe2', name: 'Priya Patel',  employee_id: 'VRN-002', role: 'executive',  city: 'Mumbai',    is_active: true, zones: { name: 'Mumbai — West' } },
  { id: 'fe3', name: 'Rahul Verma',  employee_id: 'VRN-003', role: 'executive',  city: 'Delhi',     is_active: true, zones: { name: 'Delhi — Central' } },
  { id: 'fe4', name: 'Sneha Rao',    employee_id: 'VRN-004', role: 'supervisor', city: 'Hyderabad', is_active: true, zones: { name: 'Hyderabad — South' } },
  { id: 'fe5', name: 'Amit Singh',   employee_id: 'VRN-005', role: 'executive',  city: 'Pune',      is_active: true, zones: { name: 'Pune — East' } }
];

export const getMockLearningMaterials = () => [
  { id: 'm1', title: 'IPMA Code Refresher 2026',                  description: 'Mandatory IPMA code refresher for all medical reps.', category: 'Compliance',     type: 'pdf',    file_url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', thumbnail_url: 'https://images.unsplash.com/photo-1631815589968-fdb09a223b1e?auto=format&fit=crop&w=400&q=80', page_count: 28, is_mandatory: true },
  { id: 'm2', title: 'Glucanova — Detailing Guide',                description: 'Key messages, dose initiation, side-effect mitigation.', category: 'Product',      type: 'video',  file_url: 'https://vimeo.com/836444777', thumbnail_url: 'https://images.unsplash.com/photo-1576091160550-2173dba999ef?auto=format&fit=crop&w=400&q=80', duration_min: 18, is_mandatory: true },
  { id: 'm3', title: 'Adverse Event Reporting SOP',               description: 'Pharmacovigilance — capture & escalate AE within 24h.',  category: 'Pharmacovigilance', type: 'slides', file_url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', thumbnail_url: 'https://images.unsplash.com/photo-1583912267550-aae0d44dab4a?auto=format&fit=crop&w=400&q=80', is_mandatory: true },
  { id: 'm4', title: 'Oncevia monarchE 5-yr Data Deep-Dive',     description: '5-year DFS data for adjuvant HR+ breast cancer.',         category: 'Clinical',     type: 'video',  file_url: 'https://vimeo.com/836444778', thumbnail_url: 'https://images.unsplash.com/photo-1584467735815-f778f274e296?auto=format&fit=crop&w=400&q=80', duration_min: 22, is_mandatory: false }
];
