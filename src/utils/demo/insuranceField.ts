/**
 * Insurance-vertical field-force demo fixtures — Aviva Life Insurance.
 *
 * Each function below mirrors the EXACT return shape of its generic twin in
 * `src/utils/demoData.ts` (same keys, same nesting, RAW payload — NOT wrapped
 * in `{ success, data }`, because the backend getMock* helpers return the bare
 * body and the route handlers wrap it). Only the content is re-themed to a
 * life-insurance field force: advisors/agents visiting policyholders,
 * prospects and Aviva branches; KYC / needs-analysis / renewal forms; IRDAI
 * learning.
 *
 * Consumed by demoData.ts, which branches on currentDemoIndustry().
 */
import { isoDate } from '../index';

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
    { name: 'Arjun Sharma', zone: 'Bengaluru North Branch', tff: 142 },
    { name: 'Priya Patel', zone: 'Mumbai West Branch', tff: 138 },
    { name: 'Rahul Verma', zone: 'Delhi Central Branch', tff: 135 },
    { name: 'Sneha Rao', zone: 'Hyderabad South Branch', tff: 128 },
    { name: 'Amit Singh', zone: 'Pune East Branch', tff: 122 }
  ],
  zone_performance: [
    { zone: 'Bengaluru', tff: 450, target: 500 },
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
  {
    id: '1',
    outlet_name: 'Rakesh Sharma (Policyholder) – Andheri',
    submitted_at: new Date().toISOString(),
    is_converted: true,
    user: { name: 'Arjun Sharma', zones: { city: 'Mumbai', name: 'West Branch' } },
    description: 'Arjun Sharma submitted Needs Analysis ✓',
    form_name: 'Customer Needs Analysis'
  },
  {
    id: '2',
    outlet_name: 'Aviva Branch – Bandra Kurla',
    submitted_at: new Date(Date.now() - 3600000).toISOString(),
    is_converted: false,
    user: { name: 'Priya Patel', zones: { city: 'Mumbai', name: 'West Branch' } },
    description: 'Priya Patel checked in',
    form_name: 'Attendance'
  },
  {
    id: '3',
    outlet_name: 'Meena Iyer (Prospect) – Connaught Place',
    submitted_at: new Date(Date.now() - 7200000).toISOString(),
    is_converted: true,
    user: { name: 'Rahul Verma', zones: { city: 'Delhi', name: 'Central Branch' } },
    description: 'Rahul Verma submitted KYC Verification',
    form_name: 'KYC Verification'
  }
];

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
    {
      id: 'att-1', user_id: 'fe1', status: 'checked_in', date: today, checkin_at: `${today}T09:15:00Z`, total_hours: 4.5,
      users: { name: 'Arjun Sharma', employee_id: 'AV-001', role: 'executive', zones: { name: 'Bengaluru North Branch' } }
    },
    {
      id: 'att-2', user_id: 'fe2', status: 'checked_out', date: today, checkin_at: `${today}T09:30:00Z`, checkout_at: `${today}T18:30:00Z`, total_hours: 9.0,
      users: { name: 'Priya Patel', employee_id: 'AV-002', role: 'executive', zones: { name: 'Mumbai West Branch' } }
    },
    {
      id: 'att-3', user_id: 'fe3', status: 'checked_in', date: today, checkin_at: `${today}T09:00:00Z`, total_hours: 4.8,
      users: { name: 'Rahul Verma', employee_id: 'AV-003', role: 'executive', zones: { name: 'Delhi Central Branch' } }
    },
    {
      id: 'att-4', user_id: 'fe4', status: 'checked_in', date: today, checkin_at: `${today}T10:00:00Z`, total_hours: 3.7,
      users: { name: 'Sneha Rao', employee_id: 'AV-004', role: 'supervisor', zones: { name: 'Hyderabad South Branch' } }
    },
    {
      id: 'att-5', user_id: 'fe5', status: 'checked_out', date: today, checkin_at: `${today}T08:45:00Z`, checkout_at: `${today}T17:45:00Z`, total_hours: 9.0,
      users: { name: 'Amit Singh', employee_id: 'AV-005', role: 'executive', zones: { name: 'Pune East Branch' } }
    }
  ]
});

export const getMockSubmissions = (today: string) => {
  const yesterday = new Date(new Date(today).getTime() - 86400000).toISOString().split('T')[0];

  const pics = [
    'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1534723452862-4c874018d66d?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1578916171728-46686eac8d58?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1604719312563-8912e922e9d5?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1583258292688-d0213dc5a3a8?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1472851294608-062f824d29cc?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1516594798947-e65505dbb29d?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1570126618953-d437176e8c79?auto=format&fit=crop&w=800&q=80',
    'https://images.unsplash.com/photo-1513817692823-39acdf45550a?auto=format&fit=crop&w=800&q=80'
  ];

  const data = [
    { id: 's1', user_id: 'fe1', submitted_at: `${today}T12:05:00Z`, outlet_name: 'Rakesh Sharma (Policyholder) – Andheri', users: { name: 'Arjun Sharma', employee_id: 'AV-001' }, activities: { name: 'Needs Analysis' }, photo_url: pics[0] },
    { id: 's2', user_id: 'fe2', submitted_at: `${today}T11:50:00Z`, outlet_name: 'Aviva Branch – Bandra Kurla', users: { name: 'Priya Patel', employee_id: 'AV-002' }, activities: { name: 'KYC Document Collection' }, photo_url: pics[1] },
    { id: 's3', user_id: 'fe3', submitted_at: `${today}T11:30:00Z`, outlet_name: 'Meena Iyer (Prospect) – Connaught Place', users: { name: 'Rahul Verma', employee_id: 'AV-003' }, activities: { name: 'Needs Analysis' }, photo_url: pics[2] },
    { id: 's4', user_id: 'fe4', submitted_at: `${today}T10:15:00Z`, outlet_name: 'Suresh Nair (Policyholder) – T Nagar', users: { name: 'Sneha Rao', employee_id: 'AV-004' }, activities: { name: 'Premium Collection' }, photo_url: pics[3] },
    { id: 's5', user_id: 'fe5', submitted_at: `${today}T09:45:00Z`, outlet_name: 'Aviva Branch – Banjara Hills', users: { name: 'Amit Singh', employee_id: 'AV-005' }, activities: { name: 'Claim Assistance' }, photo_url: pics[4] },
    { id: 's6', user_id: 'fe1', submitted_at: `${yesterday}T16:05:00Z`, outlet_name: 'Priya Menon (Policyholder) – Lokhandwala', users: { name: 'Arjun Sharma', employee_id: 'AV-001' }, activities: { name: 'Policy Renewal Visit' }, photo_url: pics[5] },
    { id: 's7', user_id: 'fe2', submitted_at: `${yesterday}T14:40:00Z`, outlet_name: 'Aviva Branch – Linking Road', users: { name: 'Priya Patel', employee_id: 'AV-002' }, activities: { name: 'KYC Document Collection' }, photo_url: pics[6] },
    { id: 's8', user_id: 'fe3', submitted_at: `${yesterday}T10:30:00Z`, outlet_name: 'Ramesh Gupta (Policyholder) – Bandra East', users: { name: 'Rahul Verma', employee_id: 'AV-003' }, activities: { name: 'Premium Collection' }, photo_url: pics[7] },
    { id: 's9', user_id: 'fe4', submitted_at: `${yesterday}T09:15:00Z`, outlet_name: 'Kavita Joshi (Prospect) – Khar West', users: { name: 'Sneha Rao', employee_id: 'AV-004' }, activities: { name: 'Needs Analysis' }, photo_url: pics[8] },
    { id: 's10', user_id: 'fe5', submitted_at: `${yesterday}T13:25:00Z`, outlet_name: 'Anil Khanna (Prospect) – Khan Market', users: { name: 'Amit Singh', employee_id: 'AV-005' }, activities: { name: 'Needs Analysis' }, photo_url: pics[9] },
    { id: 's11', user_id: 'fe1', submitted_at: `${today}T15:20:00Z`, outlet_name: 'Aviva Branch – CP Inner Circle', users: { name: 'Arjun Sharma', employee_id: 'AV-001' }, activities: { name: 'KYC Document Collection' }, photo_url: pics[0] },
    { id: 's12', user_id: 'fe2', submitted_at: `${today}T16:45:00Z`, outlet_name: 'Deepa Reddy (Prospect) – Andheri', users: { name: 'Priya Patel', employee_id: 'AV-002' }, activities: { name: 'Needs Analysis' }, photo_url: pics[1] },
    { id: 's13', user_id: 'fe3', submitted_at: `${today}T14:10:00Z`, outlet_name: 'Vikram Rao (Policyholder) – Saket', users: { name: 'Rahul Verma', employee_id: 'AV-003' }, activities: { name: 'Policy Renewal Visit' }, photo_url: pics[2] },
    { id: 's14', user_id: 'fe4', submitted_at: `${today}T08:30:00Z`, outlet_name: 'Aviva Branch – Banjara Hills', users: { name: 'Sneha Rao', employee_id: 'AV-004' }, activities: { name: 'Free Look Confirmation' }, photo_url: pics[3] },
    { id: 's15', user_id: 'fe1', submitted_at: `${today}T17:55:00Z`, outlet_name: 'Rakesh Sharma (Policyholder) – Andheri', users: { name: 'Arjun Sharma', employee_id: 'AV-001' }, activities: { name: 'Premium Collection' }, photo_url: pics[4] },
    { id: 's16', user_id: 'fe5', submitted_at: `${yesterday}T12:00:00Z`, outlet_name: 'Aviva Branch – Pune Central', users: { name: 'Amit Singh', employee_id: 'AV-005' }, activities: { name: 'KYC Document Collection' }, photo_url: pics[5] },
    { id: 's17', user_id: 'fe4', submitted_at: `${yesterday}T15:15:00Z`, outlet_name: 'Suresh Nair (Policyholder) – T Nagar', users: { name: 'Sneha Rao', employee_id: 'AV-004' }, activities: { name: 'Policy Renewal Visit' }, photo_url: pics[6] },
    { id: 's18', user_id: 'fe3', submitted_at: `${yesterday}T11:45:00Z`, outlet_name: 'Anil Khanna (Prospect) – Khan Market', users: { name: 'Rahul Verma', employee_id: 'AV-003' }, activities: { name: 'Needs Analysis' }, photo_url: pics[7] },
    { id: 's19', user_id: 'fe2', submitted_at: `${yesterday}T08:50:00Z`, outlet_name: 'Aviva Branch – Linking Road', users: { name: 'Priya Patel', employee_id: 'AV-002' }, activities: { name: 'KYC Document Collection' }, photo_url: pics[8] },
    { id: 's20', user_id: 'fe1', submitted_at: `${yesterday}T18:10:00Z`, outlet_name: 'Priya Menon (Policyholder) – Lokhandwala', users: { name: 'Arjun Sharma', employee_id: 'AV-001' }, activities: { name: 'Claim Assistance' }, photo_url: pics[9] }
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
        { builder_questions: { label: 'Customer Photo', qtype: 'camera' }, value_text: sub.photo_url },
        { builder_questions: { label: 'KYC Verified', qtype: 'text' }, value_text: 'Yes' },
        { builder_questions: { label: 'Protection Gap (₹L)', qtype: 'number' }, value_number: 25 }
      ]
    }))
  };
};

export const getMockSubmissionDetails = (id: string) => ({
  id,
  submitted_at: new Date().toISOString(),
  is_converted: true,
  outlet_name: 'Rakesh Sharma (Policyholder) – Andheri',
  address: 'Lokhandwala, Andheri West, Mumbai',
  latitude: 19.1360, longitude: 72.8260,
  check_in_gps: '19.1360,72.8260', check_out_gps: '19.1361,72.8261',
  users: { name: 'Arjun Sharma', employee_id: 'AV-001' },
  builder_forms: { title: 'Customer Needs Analysis' },
  activities: { name: 'Needs Analysis' },
  answers: [
    { label: 'Dependents', qtype: 'text', value: 'Spouse + 2 children' },
    { label: 'Has Existing Cover', qtype: 'yes_no', value: true },
    { label: 'PAN Card', qtype: 'camera', value: 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=800&q=80' },
    { label: 'Aadhaar Card', qtype: 'camera', value: 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=801&q=80' },
    { label: 'Customer Photo', qtype: 'camera', value: 'https://images.unsplash.com/photo-1578916171728-46686eac8d58?auto=format&fit=crop&w=800&q=80' },
    { label: 'Proposer Signature', qtype: 'signature', value: 'https://upload.wikimedia.org/wikipedia/commons/3/3a/Jon_Snow_Signature.png' }
  ],
  form_responses: [
    { builder_questions: { label: 'Dependents' }, value_text: 'Spouse + 2 children' },
    { builder_questions: { label: 'Has Existing Cover' }, value_bool: true }
  ]
});

export const getMockVisitLogs = (today: string) => [
  { id: 'v1', user_id: 'fe1', outlet_name: 'Rakesh Sharma (Policyholder) – Andheri', check_in_at: `${today}T10:00:00Z`, check_out_at: `${today}T10:45:00Z`, duration_min: 45, status: 'completed', users: { name: 'Arjun Sharma' } },
  { id: 'v2', user_id: 'fe1', outlet_name: 'Aviva Branch – Bandra Kurla', check_in_at: `${today}T11:20:00Z`, check_out_at: `${today}T12:05:00Z`, duration_min: 45, status: 'completed', users: { name: 'Arjun Sharma' } },
  { id: 'v3', user_id: 'fe2', outlet_name: 'Meena Iyer (Prospect) – Koramangala', check_in_at: `${today}T09:45:00Z`, check_out_at: `${today}T10:30:00Z`, duration_min: 45, status: 'completed', users: { name: 'Priya Patel' } },
  { id: 'v4', user_id: 'fe3', outlet_name: 'Ramesh Gupta (Policyholder) – Bandra East', check_in_at: `${today}T10:15:00Z`, check_out_at: `${today}T11:00:00Z`, duration_min: 45, status: 'completed', users: { name: 'Rahul Verma' } },
  { id: 'v5', user_id: 'fe4', outlet_name: 'Suresh Nair (Policyholder) – T Nagar', check_in_at: `${today}T13:40:00Z`, check_out_at: `${today}T14:30:00Z`, duration_min: 50, status: 'completed', users: { name: 'Sneha Rao' } },
];

export const getMockActivities = () => [
  { id: 'a1', name: 'Needs Analysis', type: 'survey', is_active: true },
  { id: 'a2', name: 'KYC Document Collection', type: 'compliance', is_active: true },
  { id: 'a3', name: 'Premium Collection', type: 'collection', is_active: true },
  { id: 'a4', name: 'Policy Renewal Visit', type: 'visit', is_active: true }
];

export const getMockStores = () => [
  { id: 'st1', name: 'Rakesh Sharma (Policyholder) – Andheri', city_id: 'c2', zone_id: 'z2', address: 'Lokhandwala, Andheri West', is_active: true, cities: { name: 'Mumbai' }, zones: { name: 'Mumbai West Branch' } },
  { id: 'st2', name: 'Aviva Branch – Bandra Kurla', city_id: 'c2', zone_id: 'z2', address: 'BKC, Bandra East', is_active: true, cities: { name: 'Mumbai' }, zones: { name: 'Mumbai West Branch' } }
];

export const getMockFormTemplates = () => [
  {
    id: 'f1',
    activity_id: 'a1',
    name: 'Customer Needs Analysis',
    description: 'Capture goals, dependents and protection gap',
    requires_photo: true,
    requires_gps: true,
    form_fields: [
      { id: 'q1', label: 'Number of Dependents', field_key: 'dependents', field_type: 'number', is_required: true, sort_order: 1 },
      { id: 'q2', label: 'Annual Income Band', field_key: 'income_band', field_type: 'select', options: ['< ₹5L', '₹5L–₹10L', '₹10L–₹25L', '₹25L–₹50L', '₹50L+'], is_required: true, sort_order: 2 },
      { id: 'q3', label: 'Customer Photo', field_key: 'photo', field_type: 'camera', is_required: true, sort_order: 3 }
    ]
  },
  {
    id: 'f2',
    activity_id: 'a2',
    name: 'KYC Verification',
    description: 'PAN / Aadhaar / address proof capture',
    requires_photo: true,
    requires_gps: true,
    form_fields: [
      { id: 'q4', label: 'PAN Number', field_key: 'pan', field_type: 'text', placeholder: 'ABCDE1234F', is_required: true, sort_order: 1 },
      { id: 'q5', label: 'Aadhaar Photo', field_key: 'aadhaar', field_type: 'camera', is_required: true, sort_order: 2 }
    ]
  }
];

export const getMockRoutePlans = (today: string) => [
  {
    id: 'rp1',
    user_id: 'fe1',
    fe_name: 'Arjun Sharma',
    fe_employee_id: 'AV-001',
    plan_date: today,
    status: 'partial',
    total_outlets: 5,
    visited_outlets: 2,
    missed_outlets: 0,
    completion_pct: 40,
    zone_name: 'Mumbai West Branch',
    city_name: 'Mumbai',
    vehicle_type: '2w_petrol',
    emission_factor_kg_per_km: 0.072,
    total_distance_km: 18.4,
    actual_distance_km: 8.2,
    co2_kg_planned: 1.32,
    co2_kg_actual: 0.59,
    outlets: [
      { id: 'o1', store_id: 'st1', store_name: 'Rakesh Sharma (Policyholder) – Andheri', visit_order: 1, status: 'completed', store_address: 'Lokhandwala, Andheri West', target_type: 'renewal', visited_at: `${today}T10:00:00Z`, checkin_at: `${today}T10:00:00Z`, checkout_at: `${today}T10:30:00Z`, planned_duration_min: 30, actual_duration_min: 30, activities: [{ name: 'Premium Collection', status: 'completed' }] },
      { id: 'o2', store_id: 'st2', store_name: 'Aviva Branch – Bandra Kurla', visit_order: 2, status: 'completed', store_address: 'BKC, Bandra East', target_type: 'kyc', visited_at: `${today}T11:15:00Z`, checkin_at: `${today}T11:15:00Z`, checkout_at: `${today}T11:50:00Z`, planned_duration_min: 30, actual_duration_min: 35, activities: [{ name: 'KYC Document Collection', status: 'completed' }] },
      { id: 'o3', store_id: 'st3', store_name: 'Meena Iyer (Prospect) – Khar West', visit_order: 3, status: 'pending', store_address: 'Khar West', target_type: 'needs_analysis', planned_duration_min: 20, activities: [{ name: 'Needs Analysis', status: 'pending' }] },
      { id: 'o4', store_id: 'st4', store_name: 'Ramesh Gupta (Policyholder) – Bandra East', visit_order: 4, status: 'pending', store_address: 'Bandra East', target_type: 'claim', planned_duration_min: 45, activities: [{ name: 'Claim Assistance', status: 'pending' }] },
      { id: 'o5', store_id: 'st5', store_name: 'Priya Menon (Policyholder) – Lokhandwala', visit_order: 5, status: 'pending', store_address: 'Lokhandwala', target_type: 'renewal', planned_duration_min: 30, activities: [{ name: 'Policy Renewal Visit', status: 'pending' }] }
    ]
  }
];

export const getMockMyRoutePlan = (today: string) => ({
  ...getMockRoutePlans(today)[0],
  id: 'unified-' + today,
  multi_plan_ids: ['rp1']
});

export const getMockCityPerformance = () => [
  { city: 'Bengaluru', zones: 12, active_fes: 45, checkins: 850, engagements: 1240, tff: 450, tff_rate: 36, unique_outlets: 380, avg_hours: 8.2, lat: 12.9716, lng: 77.5946 },
  { city: 'Mumbai', zones: 18, active_fes: 38, checkins: 720, engagements: 980, tff: 380, tff_rate: 38, unique_outlets: 320, avg_hours: 7.9, lat: 19.0760, lng: 72.8777 },
  { city: 'Delhi', zones: 15, active_fes: 32, checkins: 640, engagements: 850, tff: 320, tff_rate: 37, unique_outlets: 280, avg_hours: 8.5, lat: 28.6139, lng: 77.2090 },
  { city: 'Hyderabad', zones: 10, active_fes: 28, checkins: 510, engagements: 620, tff: 280, tff_rate: 45, unique_outlets: 240, avg_hours: 8.0, lat: 17.3850, lng: 78.4867 }
];

export const getMockOutletCoverage = () => ({
  summary: { total_outlets: 1240, total_checkins: 4500, total_tff: 1560 },
  cities: [
    { city: 'Bengaluru', total_outlets: 450, covered: 380, percentage: 84 },
    { city: 'Mumbai', total_outlets: 380, covered: 320, percentage: 84 },
    { city: 'Delhi', total_outlets: 320, covered: 280, percentage: 87 }
  ],
  outlets: [
    { name: 'Rakesh Sharma (Policyholder) – Andheri', checkins: 12, tff: 8, city: 'Mumbai', tff_rate: 66 },
    { name: 'Aviva Branch – Bandra Kurla', checkins: 15, tff: 10, city: 'Mumbai', tff_rate: 66 },
    { name: 'Meena Iyer (Prospect) – Koramangala', checkins: 10, tff: 7, city: 'Bengaluru', tff_rate: 70 },
    { name: 'Suresh Nair (Policyholder) – T Nagar', checkins: 8, tff: 5, city: 'Chennai', tff_rate: 62 },
    { name: 'Ramesh Gupta (Policyholder) – Bandra East', checkins: 14, tff: 9, city: 'Mumbai', tff_rate: 64 }
  ]
});

export const getMockMobileHome = () => ({
  attendance: { status: 'checked_in', time: '09:00 AM' },
  today_plan: { total: 5, visited: 2, pending: 3 },
  announcements: [
    { title: 'New ULIP NFO live', body: 'Aviva Wealth Builder NFO open from tomorrow. Use the latest illustration tool for pitches.' },
    { title: 'Q3 Persistency Push', body: 'Renewal premium-collection drive live. Target 90% 13th-month persistency.' }
  ],
  kpis: {
    monthly_tff: 124,
    monthly_earnings: 15400,
    target_pct: 85
  }
});

export const getMockUsers = () => [
  { id: 'fe1', name: 'Arjun Sharma', employee_id: 'AV-001', role: 'executive', city: 'Bengaluru', is_active: true, zones: { name: 'Bengaluru North Branch' } },
  { id: 'fe2', name: 'Priya Patel', employee_id: 'AV-002', role: 'executive', city: 'Mumbai', is_active: true, zones: { name: 'Mumbai West Branch' } },
  { id: 'fe3', name: 'Rahul Verma', employee_id: 'AV-003', role: 'executive', city: 'Delhi', is_active: true, zones: { name: 'Delhi Central Branch' } },
  { id: 'fe4', name: 'Sneha Rao', employee_id: 'AV-004', role: 'supervisor', city: 'Hyderabad', is_active: true, zones: { name: 'Hyderabad South Branch' } },
  { id: 'fe5', name: 'Amit Singh', employee_id: 'AV-005', role: 'executive', city: 'Pune', is_active: true, zones: { name: 'Pune East Branch' } }
];

export const getMockLearningMaterials = () => [
  { id: 'm1', title: 'IRDAI Compliance 101', description: 'Mandatory regulatory primer for all advisors.', category: 'Compliance', type: 'pdf', file_url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', thumbnail_url: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=400&q=80', page_count: 32, is_mandatory: true },
  { id: 'm2', title: 'Term vs ULIP — Advisor Guide', description: 'When to recommend protection vs investment.', category: 'Product', type: 'video', file_url: 'https://vimeo.com/836444777', thumbnail_url: 'https://images.unsplash.com/photo-1534723452862-4c874018d66d?auto=format&fit=crop&w=400&q=80', duration_min: 14, is_mandatory: true },
  { id: 'm3', title: 'Ethical Selling & Mis-selling Avoidance', description: 'Avoid mis-selling, stay IRDAI-compliant.', category: 'Compliance', type: 'slides', file_url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', thumbnail_url: 'https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?auto=format&fit=crop&w=400&q=80', is_mandatory: false }
];
