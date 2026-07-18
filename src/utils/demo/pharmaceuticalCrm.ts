/**
 * Pharmaceutical-vertical CRM demo fixtures (Vireon Pharma India).
 *
 * Mirrors the EXACT shapes of the module-level consts in
 * `src/utils/demoCrm.ts` so `demoCrmMiddleware` can swap the generic
 * dataset for this one when `currentDemoIndustry() === 'pharmaceutical'`.
 * Same ids as the generic fixtures (demo-lead-1, demo-deal-1, demo-pipe,
 * demo-stg-1..N, demo-src-1..) so the FE's by-id singleton lookups still
 * resolve. Content is themed to an Vireon Pharma Medical Representative's
 * book of business: HCPs (B2B prospects), hospital formulary deals,
 * Rx pull-through opportunities, CME / sampling activities, and a
 * pharmaceutical product portfolio.
 *
 * This is parity for mobile / fall-through; the web dashboard has its
 * own client-side pharmaceutical fixtures (kinematic-dashboard/src/lib/
 * demo/pharmaceutical/crm.ts) which this file is kept consistent with.
 */

const MRS = ['Arjun Sharma', 'Priya Patel', 'Rahul Verma', 'Sneha Rao', 'Amit Singh'];
const _now = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400000).toISOString();

// HCPs (Healthcare Practitioners) — the "lead" in pharma is the prescriber.
const LEADS = [
  { id: 'demo-lead-1',  first_name: 'Dr. Anil',    last_name: 'Mehta',    company: 'Sunrise Hospitals — Andheri',     email: 'dr.amehta@sunrise.demo',       phone: '+91 98201 11111', status: 'qualified',   score: 92, score_grade: 'A', city: 'Mumbai',    industry: 'Pharmaceutical', specialty: 'Endocrinology',    product_interest: 'Glucanova',  monthly_rx_potential: 240, source_id: 'demo-src-1', owner_id: 'demo-user-id', owner_name: MRS[0], last_activity_at: _now(-1),  created_at: _now(-14) },
  { id: 'demo-lead-2',  first_name: 'Dr. Kavita',  last_name: 'Iyer',     company: 'Meridian Hospital — Bengaluru',   email: 'dr.kiyer@meridian.demo',       phone: '+91 98202 22222', status: 'working',     score: 78, score_grade: 'A', city: 'Bengaluru', industry: 'Pharmaceutical', specialty: 'Oncology',         product_interest: 'Oncevia',  monthly_rx_potential: 120, source_id: 'demo-src-2', owner_id: 'demo-user-id', owner_name: MRS[1], last_activity_at: _now(-2),  created_at: _now(-21) },
  { id: 'demo-lead-3',  first_name: 'Dr. Suresh',  last_name: 'Kumar',    company: 'Emerald Clinic — Pune',        email: 'dr.skumar@emeraldclinic.demo',     phone: '+91 98203 33333', status: 'new',         score: 64, score_grade: 'B', city: 'Pune',      industry: 'Pharmaceutical', specialty: 'Diabetology',      product_interest: 'Diabextra', monthly_rx_potential:  85, source_id: 'demo-src-3', owner_id: 'demo-user-id', owner_name: MRS[2], last_activity_at: _now(-4),  created_at: _now(-7)  },
  { id: 'demo-lead-4',  first_name: 'Dr. Neha',    last_name: 'Gupta',    company: 'Horizon Hospitals — Hyderabad',      email: 'dr.ngupta@horizonhospitals.demo', phone: '+91 98204 44444', status: 'qualified',   score: 95, score_grade: 'A', city: 'Hyderabad', industry: 'Pharmaceutical', specialty: 'Endocrinology',    product_interest: 'Glucanova',  monthly_rx_potential: 310, source_id: 'demo-src-4', owner_id: 'demo-user-id', owner_name: MRS[0], last_activity_at: _now(-1),  created_at: _now(-30) },
  { id: 'demo-lead-5',  first_name: 'Dr. Karthik', last_name: 'Pillai',   company: 'Sunrise — Greams Road, Chennai',  email: 'dr.kpillai@sunrise.demo',      phone: '+91 98205 55555', status: 'working',     score: 58, score_grade: 'B', city: 'Chennai',   industry: 'Pharmaceutical', specialty: 'Cardiology',       product_interest: 'Glyzentia', monthly_rx_potential:  72, source_id: 'demo-src-5', owner_id: 'demo-user-id', owner_name: MRS[3], last_activity_at: _now(-5),  created_at: _now(-18) },
  { id: 'demo-lead-6',  first_name: 'Dr. Pooja',   last_name: 'Joshi',    company: 'Central City Hospital — Jaipur',          email: 'dr.pjoshi@centralcityhospital.demo',  phone: '+91 98206 66666', status: 'unqualified', score: 22, score_grade: 'D', city: 'Jaipur',    industry: 'Pharmaceutical', specialty: 'General Medicine', product_interest: 'Insulora',   monthly_rx_potential:  18, source_id: 'demo-src-6', owner_id: 'demo-user-id', owner_name: MRS[4], last_activity_at: _now(-9),  created_at: _now(-35) },
  { id: 'demo-lead-7',  first_name: 'Dr. Manish',  last_name: 'Khanna',   company: 'Lakeview — Andheri West',       email: 'dr.mkhanna@lakeview.demo',   phone: '+91 98207 77777', status: 'qualified',   score: 84, score_grade: 'A', city: 'Mumbai',    industry: 'Pharmaceutical', specialty: 'Oncology',         product_interest: 'Oncevia',  monthly_rx_potential: 165, source_id: 'demo-src-2', owner_id: 'demo-user-id', owner_name: MRS[1], last_activity_at: _now(-3),  created_at: _now(-25) },
  { id: 'demo-lead-8',  first_name: 'Dr. Ishaan',  last_name: 'Bose',     company: 'Riverside Hospitals — Salt Lake',     email: 'dr.ibose@riverside.demo',          phone: '+91 98208 88888', status: 'nurturing',   score: 48, score_grade: 'C', city: 'Kolkata',   industry: 'Pharmaceutical', specialty: 'Rheumatology',     product_interest: 'Rheumolex',  monthly_rx_potential:  62, source_id: 'demo-src-3', owner_id: 'demo-user-id', owner_name: MRS[2], last_activity_at: _now(-12), created_at: _now(-42) },
  { id: 'demo-lead-9',  first_name: 'Dr. Tanvi',   last_name: 'Mehta',    company: 'Cornerstone Hospital — Ahmedabad',  email: 'dr.tmehta@cornerstone.demo',     phone: '+91 98209 99999', status: 'new',         score: 70, score_grade: 'B', city: 'Ahmedabad', industry: 'Pharmaceutical', specialty: 'Diabetology',      product_interest: 'Diabextra', monthly_rx_potential:  98, source_id: 'demo-src-1', owner_id: 'demo-user-id', owner_name: MRS[3], last_activity_at: _now(-1),  created_at: _now(-5)  },
  { id: 'demo-lead-10', first_name: 'Dr. Karan',   last_name: 'Verma',    company: 'Northgate — Delhi',                email: 'dr.kverma@northgate.demo',       phone: '+91 98210 10101', status: 'working',     score: 88, score_grade: 'A', city: 'Delhi',     industry: 'Pharmaceutical', specialty: 'Neurology',        product_interest: 'Migranova',  monthly_rx_potential: 140, source_id: 'demo-src-7', owner_id: 'demo-user-id', owner_name: MRS[0], last_activity_at: _now(-2),  created_at: _now(-11) },
  { id: 'demo-lead-11', first_name: 'Dr. Aditya',  last_name: 'Nair',     company: 'Crescent — Bannerghatta',          email: 'dr.anair@crescent.demo',        phone: '+91 98211 12121', status: 'qualified',   score: 81, score_grade: 'A', city: 'Bengaluru', industry: 'Pharmaceutical', specialty: 'Endocrinology',    product_interest: 'Glucanova',  monthly_rx_potential: 205, source_id: 'demo-src-5', owner_id: 'demo-user-id', owner_name: MRS[1], last_activity_at: _now(-1),  created_at: _now(-28) },
  { id: 'demo-lead-12', first_name: 'Dr. Diya',    last_name: 'Kapoor',   company: 'Trinity International — Chennai',   email: 'dr.dkapoor@trinity.demo',        phone: '+91 98212 13131', status: 'new',         score: 38, score_grade: 'C', city: 'Chennai',   industry: 'Pharmaceutical', specialty: 'Oncology',         product_interest: 'Oncevia',  monthly_rx_potential:  55, source_id: 'demo-src-2', owner_id: 'demo-user-id', owner_name: MRS[2], last_activity_at: _now(-6),  created_at: _now(-9)  },
];

const ACCOUNTS = [
  { id: 'demo-acct-1', name: 'Sunrise Hospitals Enterprise',   domain: 'sunrisehospitals.demo',  industry: 'Hospital Network',    annual_revenue: 165000000000, owner_id: 'demo-user-id', owner_name: MRS[0], created_at: _now(-180) },
  { id: 'demo-acct-2', name: 'Meridian Health Enterprises',    domain: 'meridianhospitals.demo', industry: 'Hospital Network',    annual_revenue:  92000000000, owner_id: 'demo-user-id', owner_name: MRS[1], created_at: _now(-160) },
  { id: 'demo-acct-3', name: 'Crescent Healthcare',              domain: 'crescenthealthcare.demo', industry: 'Hospital Network',    annual_revenue:  58000000000, owner_id: 'demo-user-id', owner_name: MRS[2], created_at: _now(-145) },
  { id: 'demo-acct-4', name: 'AIIMS Delhi',                    domain: 'aiims.demo',            industry: 'Government Hospital', annual_revenue: 0,            owner_id: 'demo-user-id', owner_name: MRS[0], created_at: _now(-200) },
  { id: 'demo-acct-5', name: 'WellCare Pharmacy Chain',         domain: 'wellcare.demo',          industry: 'Retail Pharmacy',     annual_revenue:  42000000000, owner_id: 'demo-user-id', owner_name: MRS[3], created_at: _now(-90)  },
  { id: 'demo-acct-6', name: 'Sunrise Pharmacy',                domain: 'sunrisepharmacy.demo',   industry: 'Retail Pharmacy',     annual_revenue:  64000000000, owner_id: 'demo-user-id', owner_name: MRS[4], created_at: _now(-110) },
  { id: 'demo-acct-7', name: 'Metropolis Cancer Centre',           domain: 'metropolis.demo',              industry: 'Cancer Specialty',    annual_revenue:  18000000000, owner_id: 'demo-user-id', owner_name: MRS[1], created_at: _now(-130) },
  { id: 'demo-acct-8', name: 'Lakeview — Mumbai',             domain: 'lakeview.demo',        industry: 'Hospital Network',    annual_revenue:  24000000000, owner_id: 'demo-user-id', owner_name: MRS[2], created_at: _now(-100) },
];

const CONTACTS = [
  { id: 'demo-ctc-1', first_name: 'Dr. Anil',   last_name: 'Mehta',   email: 'dr.amehta@sunrise.demo',       phone: '+91 98201 11111', title: 'Consultant Endocrinologist',  account_id: 'demo-acct-1', account_name: 'Sunrise Hospitals Enterprise',  owner_id: 'demo-user-id', owner_name: MRS[0] },
  { id: 'demo-ctc-2', first_name: 'Dr. Kavita', last_name: 'Iyer',    email: 'dr.kiyer@meridian.demo',       phone: '+91 98202 22222', title: 'Sr. Oncologist',               account_id: 'demo-acct-2', account_name: 'Meridian Health Enterprises',   owner_id: 'demo-user-id', owner_name: MRS[1] },
  { id: 'demo-ctc-3', first_name: 'Dr. Suresh', last_name: 'Kumar',   email: 'dr.skumar@emeraldclinic.demo',     phone: '+91 98203 33333', title: 'HOD Diabetology',              account_id: 'demo-acct-3', account_name: 'Crescent Healthcare',             owner_id: 'demo-user-id', owner_name: MRS[2] },
  { id: 'demo-ctc-4', first_name: 'Dr. Neha',   last_name: 'Gupta',   email: 'dr.ngupta@horizonhospitals.demo', phone: '+91 98204 44444', title: 'Sr. Endocrinologist',          account_id: 'demo-acct-4', account_name: 'AIIMS Delhi',                   owner_id: 'demo-user-id', owner_name: MRS[0] },
  { id: 'demo-ctc-5', first_name: 'Rajesh',     last_name: 'Iyer',    email: 'rajesh.iyer@wellcare.demo',    phone: '+91 98205 55555', title: 'Category Head — Chronic',      account_id: 'demo-acct-5', account_name: 'WellCare Pharmacy Chain',        owner_id: 'demo-user-id', owner_name: MRS[3] },
  { id: 'demo-ctc-6', first_name: 'Sunita',     last_name: 'Menon',   email: 'sunita.menon@sunrisepharmacy.demo', phone: '+91 98206 66666', title: 'Procurement Director',     account_id: 'demo-acct-6', account_name: 'Sunrise Pharmacy',               owner_id: 'demo-user-id', owner_name: MRS[4] },
  { id: 'demo-ctc-7', first_name: 'Dr. Manish', last_name: 'Khanna',  email: 'dr.mkhanna@lakeview.demo',   phone: '+91 98207 77777', title: 'Senior Oncologist',            account_id: 'demo-acct-8', account_name: 'Lakeview — Mumbai',            owner_id: 'demo-user-id', owner_name: MRS[1] },
  { id: 'demo-ctc-8', first_name: 'Dr. R. K.',  last_name: 'Tandon',  email: 'rk.tandon@metropolis.demo',          phone: '+91 98213 14141', title: 'Director — Oncology',          account_id: 'demo-acct-7', account_name: 'Metropolis Cancer Centre',          owner_id: 'demo-user-id', owner_name: MRS[1] },
];

const HCP_STAGES = [
  { id: 'demo-stg-1', pipeline_id: 'demo-pipe', name: 'New HCP',                position: 0, probability: 10,  stage_type: 'open', color: '#94a3b8' },
  { id: 'demo-stg-2', pipeline_id: 'demo-pipe', name: 'Detailing Visit',        position: 1, probability: 25,  stage_type: 'open', color: '#60a5fa' },
  { id: 'demo-stg-3', pipeline_id: 'demo-pipe', name: 'Sampling',               position: 2, probability: 45,  stage_type: 'open', color: '#a78bfa' },
  { id: 'demo-stg-4', pipeline_id: 'demo-pipe', name: 'Trial Rx',               position: 3, probability: 65,  stage_type: 'open', color: '#f59e0b' },
  { id: 'demo-stg-5', pipeline_id: 'demo-pipe', name: 'Adopted Prescriber',     position: 4, probability: 82,  stage_type: 'open', color: '#fbbf24' },
  { id: 'demo-stg-6', pipeline_id: 'demo-pipe', name: 'Loyal Prescriber',       position: 5, probability: 100, stage_type: 'won',  color: '#22c55e' },
  { id: 'demo-stg-7', pipeline_id: 'demo-pipe', name: 'Lapsed / Switched',      position: 6, probability: 0,   stage_type: 'lost', color: '#ef4444' },
];

const INST_STAGES = [
  { id: 'inst-stg-1', pipeline_id: 'demo-pipe-institutional', name: 'Identified',          position: 0, probability: 10,  stage_type: 'open', color: '#94a3b8' },
  { id: 'inst-stg-2', pipeline_id: 'demo-pipe-institutional', name: 'Formulary Submitted', position: 1, probability: 35,  stage_type: 'open', color: '#60a5fa' },
  { id: 'inst-stg-3', pipeline_id: 'demo-pipe-institutional', name: 'P&T Committee',       position: 2, probability: 60,  stage_type: 'open', color: '#a78bfa' },
  { id: 'inst-stg-4', pipeline_id: 'demo-pipe-institutional', name: 'Tender / Price Nego', position: 3, probability: 80,  stage_type: 'open', color: '#f59e0b' },
  { id: 'inst-stg-5', pipeline_id: 'demo-pipe-institutional', name: 'Listed / Awarded',    position: 4, probability: 100, stage_type: 'won',  color: '#22c55e' },
  { id: 'inst-stg-6', pipeline_id: 'demo-pipe-institutional', name: 'Rejected',            position: 5, probability: 0,   stage_type: 'lost', color: '#ef4444' },
];

const STAGES = HCP_STAGES;

const PIPELINES = [
  { id: 'demo-pipe',               name: 'Vireon Pharma — HCP Engagement', is_default: true,  stages: HCP_STAGES },
  { id: 'demo-pipe-institutional', name: 'Hospital / Formulary',       is_default: false, stages: INST_STAGES },
];

const DEALS = [
  { id: 'demo-deal-1',  name: 'Dr. Anil Mehta — Glucanova adoption',          account_id: 'demo-acct-1', account_name: 'Sunrise Hospitals Enterprise',  pipeline_id: 'demo-pipe', stage_id: 'demo-stg-3', stage_name: 'Sampling',           stage_type: 'open', status: 'open', amount: 2400000,  currency: 'INR', probability: 45,  win_probability_ai: 58,  owner_id: 'demo-user-id', owner_name: MRS[0], expected_close_date: _now(12).slice(0,10), created_at: _now(-30) },
  { id: 'demo-deal-2',  name: 'Dr. Kavita Iyer — Oncevia Rx pull-through',  account_id: 'demo-acct-2', account_name: 'Meridian Health Enterprises',   pipeline_id: 'demo-pipe', stage_id: 'demo-stg-5', stage_name: 'Adopted Prescriber', stage_type: 'open', status: 'open', amount: 4800000,  currency: 'INR', probability: 82,  win_probability_ai: 84,  owner_id: 'demo-user-id', owner_name: MRS[1], expected_close_date: _now(6).slice(0,10),  created_at: _now(-45) },
  { id: 'demo-deal-3',  name: 'Dr. Suresh Kumar — Diabextra trial',          account_id: 'demo-acct-3', account_name: 'Crescent Healthcare',             pipeline_id: 'demo-pipe', stage_id: 'demo-stg-2', stage_name: 'Detailing Visit',    stage_type: 'open', status: 'open', amount: 1020000,  currency: 'INR', probability: 25,  win_probability_ai: 33,  owner_id: 'demo-user-id', owner_name: MRS[2], expected_close_date: _now(28).slice(0,10), created_at: _now(-14) },
  { id: 'demo-deal-4',  name: 'Dr. Neha Gupta — Glucanova formulary',         account_id: 'demo-acct-4', account_name: 'AIIMS Delhi',                    pipeline_id: 'demo-pipe', stage_id: 'demo-stg-4', stage_name: 'Trial Rx',           stage_type: 'open', status: 'open', amount: 3720000,  currency: 'INR', probability: 65,  win_probability_ai: 70,  owner_id: 'demo-user-id', owner_name: MRS[0], expected_close_date: _now(10).slice(0,10), created_at: _now(-50) },
  { id: 'demo-deal-5',  name: 'Dr. Karthik Pillai — Glyzentia adopt',        account_id: 'demo-acct-1', account_name: 'Sunrise Hospitals Enterprise',   pipeline_id: 'demo-pipe', stage_id: 'demo-stg-1', stage_name: 'New HCP',            stage_type: 'open', status: 'open', amount:  860000,  currency: 'INR', probability: 10,  win_probability_ai: 20,  owner_id: 'demo-user-id', owner_name: MRS[3], expected_close_date: _now(35).slice(0,10), created_at: _now(-8)  },
  { id: 'demo-deal-6',  name: 'Dr. Manish Khanna — Oncevia adoption',       account_id: 'demo-acct-8', account_name: 'Lakeview — Mumbai',             pipeline_id: 'demo-pipe', stage_id: 'demo-stg-5', stage_name: 'Adopted Prescriber', stage_type: 'open', status: 'open', amount: 1980000,  currency: 'INR', probability: 82,  win_probability_ai: 86,  owner_id: 'demo-user-id', owner_name: MRS[1], expected_close_date: _now(4).slice(0,10),  created_at: _now(-22) },
  { id: 'demo-deal-7',  name: 'Dr. Aditya Nair — Glucanova switch',           account_id: 'demo-acct-3', account_name: 'Crescent Healthcare',              pipeline_id: 'demo-pipe', stage_id: 'demo-stg-2', stage_name: 'Detailing Visit',    stage_type: 'open', status: 'open', amount: 2460000,  currency: 'INR', probability: 25,  win_probability_ai: 38,  owner_id: 'demo-user-id', owner_name: MRS[2], expected_close_date: _now(22).slice(0,10), created_at: _now(-10) },
  { id: 'demo-deal-8',  name: 'Dr. Tanvi Mehta — Diabextra expansion',       account_id: 'demo-acct-3', account_name: 'Crescent Healthcare',              pipeline_id: 'demo-pipe', stage_id: 'demo-stg-1', stage_name: 'New HCP',            stage_type: 'open', status: 'open', amount: 1180000,  currency: 'INR', probability: 10,  win_probability_ai: 18,  owner_id: 'demo-user-id', owner_name: MRS[3], expected_close_date: _now(40).slice(0,10), created_at: _now(-5)  },
  { id: 'demo-deal-9',  name: 'Dr. Karan Verma — Migranova switch',           account_id: 'demo-acct-3', account_name: 'Crescent Healthcare',              pipeline_id: 'demo-pipe', stage_id: 'demo-stg-6', stage_name: 'Loyal Prescriber',   stage_type: 'won',  status: 'won',  amount: 1680000,  currency: 'INR', probability: 100, win_probability_ai: 100, owner_id: 'demo-user-id', owner_name: MRS[0], actual_close_date: _now(-3).slice(0,10),  created_at: _now(-65) },
  { id: 'demo-deal-10', name: 'Sunrise Pharmacy — Diabextra tender',          account_id: 'demo-acct-6', account_name: 'Sunrise Pharmacy',                pipeline_id: 'demo-pipe-institutional', stage_id: 'inst-stg-5', stage_name: 'Listed / Awarded', stage_type: 'won',  status: 'won',  amount: 18500000, currency: 'INR', probability: 100, win_probability_ai: 100, owner_id: 'demo-user-id', owner_name: MRS[4], actual_close_date: _now(-12).slice(0,10), created_at: _now(-80) },
  { id: 'demo-deal-11', name: 'Metropolis Cancer Centre — Oncevia formulary',          account_id: 'demo-acct-7', account_name: 'Metropolis Cancer Centre',           pipeline_id: 'demo-pipe-institutional', stage_id: 'inst-stg-3', stage_name: 'P&T Committee',    stage_type: 'open', status: 'open', amount: 12400000, currency: 'INR', probability: 60,  win_probability_ai: 64,  owner_id: 'demo-user-id', owner_name: MRS[1], expected_close_date: _now(45).slice(0,10), created_at: _now(-90) },
  { id: 'demo-deal-12', name: 'AIIMS Delhi — Glucanova tender',               account_id: 'demo-acct-4', account_name: 'AIIMS Delhi',                    pipeline_id: 'demo-pipe-institutional', stage_id: 'inst-stg-4', stage_name: 'Tender / Price Nego', stage_type: 'open', status: 'open', amount: 22500000, currency: 'INR', probability: 80,  win_probability_ai: 78,  owner_id: 'demo-user-id', owner_name: MRS[0], expected_close_date: _now(20).slice(0,10), created_at: _now(-110) },
  { id: 'demo-deal-13', name: 'WellCare — Insulora supply (annual)',           account_id: 'demo-acct-5', account_name: 'WellCare Pharmacy Chain',         pipeline_id: 'demo-pipe-institutional', stage_id: 'inst-stg-5', stage_name: 'Listed / Awarded', stage_type: 'won',  status: 'won',  amount:  8400000, currency: 'INR', probability: 100, win_probability_ai: 100, owner_id: 'demo-user-id', owner_name: MRS[3], actual_close_date: _now(-25).slice(0,10), created_at: _now(-150) },
  { id: 'demo-deal-14', name: 'Dr. Pooja Joshi — Insulora (Lost)',            account_id: 'demo-acct-4', account_name: 'AIIMS Delhi',                    pipeline_id: 'demo-pipe', stage_id: 'demo-stg-7', stage_name: 'Lapsed / Switched',  stage_type: 'lost', status: 'lost', amount:   320000, currency: 'INR', probability: 0,   win_probability_ai: 0,   owner_id: 'demo-user-id', owner_name: MRS[4], actual_close_date: _now(-18).slice(0,10), lost_reason: 'Switched to generic insulin', created_at: _now(-60) },
];

const ACTIVITIES = [
  { id: 'demo-act-1',  type: 'meeting', subject: 'Detailing — Glucanova w/ Dr. Mehta',     status: 'completed', completed_at: _now(-1), lead_id: 'demo-lead-1',  deal_id: 'demo-deal-1',  assigned_to: 'demo-user-id', assigned_to_name: MRS[0] },
  { id: 'demo-act-2',  type: 'email',   subject: 'Oncevia clinical evidence shared',     status: 'completed', completed_at: _now(-2), lead_id: 'demo-lead-2',  deal_id: null,           assigned_to: 'demo-user-id', assigned_to_name: MRS[1] },
  { id: 'demo-act-3',  type: 'meeting', subject: 'Sample drop — Diabextra, Sunrise',       status: 'completed', completed_at: _now(-3), lead_id: null,           deal_id: 'demo-deal-1',  assigned_to: 'demo-user-id', assigned_to_name: MRS[0] },
  { id: 'demo-act-4',  type: 'note',    subject: 'Dr. Iyer requesting Oncevia CME slot', status: 'completed', completed_at: _now(-5), lead_id: null,           deal_id: 'demo-deal-2',  assigned_to: 'demo-user-id', assigned_to_name: MRS[1] },
  { id: 'demo-act-5',  type: 'call',    subject: 'Follow-up — Dr. Kumar trial Rx',        status: 'completed', completed_at: _now(-4), lead_id: 'demo-lead-3',  deal_id: null,           assigned_to: 'demo-user-id', assigned_to_name: MRS[2] },
  { id: 'demo-act-6',  type: 'task',    subject: 'Send Glyzentia brief — Dr. Pillai',     status: 'planned',   due_at: _now(2),        lead_id: null,           deal_id: 'demo-deal-5',  assigned_to: 'demo-user-id', assigned_to_name: MRS[3] },
  { id: 'demo-act-7',  type: 'meeting', subject: 'AIIMS P&T committee prep',              status: 'completed', completed_at: _now(-1), lead_id: null,           deal_id: 'demo-deal-12', assigned_to: 'demo-user-id', assigned_to_name: MRS[0] },
  { id: 'demo-act-8',  type: 'email',   subject: 'CME invitation — Migranova migraine',    status: 'completed', completed_at: _now(-6), lead_id: 'demo-lead-10', deal_id: null,           assigned_to: 'demo-user-id', assigned_to_name: MRS[0] },
  { id: 'demo-act-9',  type: 'meeting', subject: 'KOL roundtable — Metropolis Cancer Centre',        status: 'completed', completed_at: _now(-8), lead_id: null,           deal_id: 'demo-deal-11', assigned_to: 'demo-user-id', assigned_to_name: MRS[1] },
  { id: 'demo-act-10', type: 'task',    subject: 'Oncevia adverse-event report close',   status: 'planned',   due_at: _now(1),        lead_id: null,           deal_id: 'demo-deal-6',  assigned_to: 'demo-user-id', assigned_to_name: MRS[4] },
  { id: 'demo-act-11', type: 'call',    subject: 'New HCP cold call — Dr. Tanvi Mehta',   status: 'completed', completed_at: _now(-1), lead_id: 'demo-lead-9',  deal_id: null,           assigned_to: 'demo-user-id', assigned_to_name: MRS[3] },
  { id: 'demo-act-12', type: 'note',    subject: 'PSP enrolment — 14 patients',           status: 'completed', completed_at: _now(-9), lead_id: 'demo-lead-11', deal_id: null,           assigned_to: 'demo-user-id', assigned_to_name: MRS[1] },
];

const SOURCES = [
  { id: 'demo-src-1', name: 'Field Detailing',     cost_per_lead: 0,    is_active: true },
  { id: 'demo-src-2', name: 'CME / Symposia',      cost_per_lead: 3500, is_active: true },
  { id: 'demo-src-3', name: 'KOL Referral',        cost_per_lead: 0,    is_active: true },
  { id: 'demo-src-4', name: 'Medical Conference',  cost_per_lead: 8200, is_active: true },
  { id: 'demo-src-5', name: 'Digital HCP Webinar', cost_per_lead:  900, is_active: true },
];

const DEMO_DASHBOARD_SUMMARY = {
  total_leads: LEADS.length,
  new_leads:        LEADS.filter(l => l.status === 'new').length,
  qualified_leads:  LEADS.filter(l => l.status === 'qualified').length,
  converted_leads:  5,
  total_deals:      DEALS.length,
  open_deals:       DEALS.filter(d => d.status === 'open').length,
  won_deals:        DEALS.filter(d => d.status === 'won').length,
  lost_deals:       DEALS.filter(d => d.status === 'lost').length,
  pipeline_value:   DEALS.filter(d => d.status === 'open').reduce((s,d) => s + d.amount, 0),
  closed_revenue:   DEALS.filter(d => d.status === 'won').reduce((s,d) => s + d.amount, 0),
  win_rate:         Math.round(DEALS.filter(d => d.status === 'won').length / Math.max(1, DEALS.filter(d => d.status !== 'open').length) * 100),
  avg_score:        Math.round(LEADS.reduce((s,l) => s + l.score, 0) / LEADS.length),
  total_activities: ACTIVITIES.length,
  total_contacts:   CONTACTS.length,
};

const DEMO_PIPELINE_VALUE = STAGES.filter(s => s.stage_type === 'open').map(s => {
  const deals = DEALS.filter(d => d.stage_id === s.id && d.status === 'open');
  const total = deals.reduce((acc, d) => acc + d.amount, 0);
  return {
    stage_id: s.id, stage_name: s.name, stage_type: s.stage_type, position: s.position,
    deal_count: deals.length, total_amount: total,
    weighted_amount: Math.round(total * (s.probability / 100)),
  };
});

const DEMO_FUNNEL = [
  { stage: 'New HCP',            count: 48, value: 1_440_000 },
  { stage: 'Detailing Visit',    count: 36, value: 2_160_000 },
  { stage: 'Sampling',           count: 22, value: 1_980_000 },
  { stage: 'Trial Rx',           count: 14, value: 1_960_000 },
  { stage: 'Adopted Prescriber', count:  9, value: 2_700_000 },
  { stage: 'Loyal Prescriber',   count:  6, value: 3_600_000 },
];

const DEMO_WIN_RATE_BY_REP = MRS.map((name, i) => ({
  rep_id: 'demo-user-id', rep_name: name,
  won: 6 - i, lost: i, total_closed: 6 - i + i,
  win_rate: Math.max(0, Math.round((6 - i) / Math.max(1, 6) * 100)),
  revenue: [18500000, 8400000, 4800000, 1980000, 1680000][i] || 0,
}));

const DEMO_FORECAST = (() => {
  const now = new Date();
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    return {
      period: d.toISOString().slice(0, 7),
      committed:   8_500_000 + i * 1_200_000,
      best_case:  14_400_000 + i * 1_800_000,
      pipeline:   24_600_000 + i * 2_400_000,
      target:     18_000_000,
    };
  });
})();

const DEMO_HEATMAP = (() => {
  const dows = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const out: Array<{ dow: string; hour: number; count: number }> = [];
  for (const dow of dows) {
    for (let h = 8; h < 20; h++) {
      const peak = dow !== 'Sun' && ((h >= 10 && h <= 13) || (h >= 17 && h <= 20));
      out.push({ dow, hour: h, count: peak ? Math.round(4 + Math.random() * 12) : Math.round(Math.random() * 3) });
    }
  }
  return out;
})();

const DEMO_LEAD_SOURCE_ROI = SOURCES.map((s, i) => ({
  source_id: s.id, source_name: s.name,
  leads:     [22, 14, 18, 8, 12][i],
  qualified: [14, 10, 12, 5, 6][i],
  won:       [8,  6,  5,  3, 3][i],
  cost:      [0, 14 * s.cost_per_lead, 0, 8 * s.cost_per_lead, 12 * s.cost_per_lead][i],
  revenue:   [4800000, 3600000, 2400000, 1680000, 1200000][i] || 0,
}));

const DEMO_SCORE_DIST = [
  { bucket: '0-20',   count: 2 },
  { bucket: '21-40',  count: 5 },
  { bucket: '41-60',  count: 9 },
  { bucket: '61-80',  count: 14 },
  { bucket: '81-100', count: 12 },
];

const DEMO_SALES_CYCLE = [
  { stage: 'New HCP',            avg_days: 4 },
  { stage: 'Detailing Visit',    avg_days: 8 },
  { stage: 'Sampling',           avg_days: 12 },
  { stage: 'Trial Rx',           avg_days: 22 },
  { stage: 'Adopted Prescriber', avg_days: 36 },
];

const DEMO_DASHBOARD_COMPLETE = {
  unit: 'inr',
  summary: DEMO_DASHBOARD_SUMMARY,
  pipelineValue: DEMO_PIPELINE_VALUE,
  funnel: DEMO_FUNNEL,
  winRate: DEMO_WIN_RATE_BY_REP,
  forecast: DEMO_FORECAST,
  leadScoreDistribution: DEMO_SCORE_DIST,
};

const DEMO_TERRITORIES = [
  { id: 'demo-terr-1', name: 'West India',  is_active: true },
  { id: 'demo-terr-2', name: 'South India', is_active: true },
  { id: 'demo-terr-3', name: 'North India', is_active: true },
  { id: 'demo-terr-4', name: 'East India',  is_active: true },
];

// Vireon Pharma portfolio (India indicative MRP per pack / per device).
const DEMO_PRODUCTS = [
  { id: 'demo-prod-1', name: 'Glucanova (Tirzepatide) 5mg',     sku: 'VRN-MNJ-5',   unit_price: 14000,  unit: 'pen/4wk',  is_active: true },
  { id: 'demo-prod-2', name: 'Diabextra (Dulaglutide) 1.5mg',  sku: 'VRN-TRU-15',  unit_price:  8800,  unit: 'pen/4wk',  is_active: true },
  { id: 'demo-prod-3', name: 'Insulora (Insulin Lispro)',        sku: 'VRN-HUM',     unit_price:  1450,  unit: 'cartridge',is_active: true },
  { id: 'demo-prod-4', name: 'Oncevia (Abemaciclib) 150mg',    sku: 'VRN-VRZ-150', unit_price:185000,  unit: 'pack/28',  is_active: true },
  { id: 'demo-prod-5', name: 'Rheumolex (Baricitinib) 4mg',      sku: 'VRN-OLU-4',   unit_price: 12500,  unit: 'pack/28',  is_active: true },
  { id: 'demo-prod-6', name: 'Migranova (Galcanezumab) 120mg',   sku: 'VRN-EMG',     unit_price: 22000,  unit: 'pen/4wk',  is_active: true },
  { id: 'demo-prod-7', name: 'Oncorib (Ramucirumab) 100mg',     sku: 'VRN-CYR',     unit_price:152000,  unit: 'vial',     is_active: true },
];

const DEMO_LEAD_VELOCITY = (() => {
  const now = new Date();
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    const total = 60 + i * 9;
    const qualified = Math.round(total * (0.42 + i * 0.03));
    const prev = i === 0 ? null : Math.round((60 + (i - 1) * 9) * (0.42 + (i - 1) * 0.03));
    const mom = prev == null ? null : Math.round(((qualified - prev) / prev) * 1000) / 10;
    return { month: d.toISOString().slice(0, 7), total, qualified, mom_growth_pct: mom };
  });
})();

const DEMO_TIME_TO_FIRST_TOUCH = {
  avg_minutes: 42,
  median_minutes: 28,
  sla_breach_pct: 11.4,
  total: 168,
  breaches: 19,
  sla_minutes: 60,
  distribution: [
    { bucket: '<5m',    count: 28 },
    { bucket: '5-15m',  count: 52 },
    { bucket: '15-60m', count: 56 },
    { bucket: '1-4h',   count: 18 },
    { bucket: '4-24h',  count: 11 },
    { bucket: '>24h',   count: 3 },
  ],
};

const DEMO_STUCK_LEADS_KPI = {
  count_7d: 12,
  count_14d: 5,
  count_30d: 2,
  top_owners: [
    { owner_id: 'demo-user-id', count: 3 },
    { owner_id: 'demo-user-2',  count: 2 },
    { owner_id: 'demo-user-3',  count: 1 },
  ],
};

const DEMO_LOST_REASONS = [
  { reason: 'Switched to generic',          count: 14 },
  { reason: 'Competitor (Novo, MSD)',       count: 11 },
  { reason: 'Formulary delisted',           count: 7 },
  { reason: 'Cost / patient affordability', count: 9 },
  { reason: 'Adverse event report',         count: 4 },
  { reason: 'No prescribing intent',        count: 6 },
];

const DEMO_WON_REASONS = [
  { reason: 'Strong clinical data',         count: 18 },
  { reason: 'KOL endorsement',              count: 11 },
  { reason: 'PSP / affordability scheme',   count: 9 },
  { reason: 'Better tolerability',          count: 7 },
  { reason: 'Convenient dosing schedule',   count: 6 },
];

const DEMO_DISQUAL_REASONS = [
  { reason: 'Low patient volume',         count: 8 },
  { reason: 'Out of therapy area',        count: 6 },
  { reason: 'DnD (do not detail) list',   count: 4 },
  { reason: 'Retired / left practice',    count: 3 },
];

const DEMO_STAGE_CONVERSION = [
  { from_stage: 'New HCP',         to_stage: 'Detailing Visit',    entered: 64, advanced: 48, rate: 75.0 },
  { from_stage: 'Detailing Visit', to_stage: 'Sampling',           entered: 48, advanced: 31, rate: 64.6 },
  { from_stage: 'Sampling',        to_stage: 'Trial Rx',           entered: 31, advanced: 18, rate: 58.1 },
  { from_stage: 'Trial Rx',        to_stage: 'Adopted Prescriber', entered: 18, advanced: 12, rate: 66.7 },
];

const DEMO_LEAD_AGING = [
  { bucket: '0-7d',   count: 18 },
  { bucket: '8-30d',  count: 22 },
  { bucket: '31-60d', count: 9 },
  { bucket: '60+d',   count: 5 },
];

const DEMO_COHORT_CONVERSION = (() => {
  const now = new Date();
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    const total = 36 + i * 5;
    const cells = Array.from({ length: 7 }, (_, age) => {
      const cumPct = Math.min(52, age * (8 + i));
      return { age_months: age, converted: Math.round(total * (cumPct / 100)), rate: cumPct };
    });
    return { cohort_month: d.toISOString().slice(0, 7), total, cells };
  });
})();

const DEMO_ENGAGEMENT_COMPARISON = {
  won:  { avg: 9.4, count: 18 },
  lost: { avg: 3.1, count: 24 },
};

const DEMO_DAYS_SINCE_TOUCH = [
  { bucket: '0d',     count: 11 },
  { bucket: '1-3d',   count: 20 },
  { bucket: '4-7d',   count: 14 },
  { bucket: '8-14d',  count: 7 },
  { bucket: '15-30d', count: 4 },
  { bucket: '30+d',   count: 2 },
];

const DEMO_SCORE_BAND_CONVERSION = [
  { band: '0-19',   total: 10, converted: 1,  rate: 10.0 },
  { band: '20-39',  total: 22, converted: 4,  rate: 18.2 },
  { band: '40-59',  total: 30, converted: 10, rate: 33.3 },
  { band: '60-79',  total: 34, converted: 19, rate: 55.9 },
  { band: '80-100', total: 21, converted: 15, rate: 71.4 },
];

const DEMO_TERRITORY_CONVERSION = [
  { territory: 'Maharashtra', total: 52, converted: 20, rate: 38.5 },
  { territory: 'Karnataka',   total: 38, converted: 15, rate: 39.5 },
  { territory: 'Tamil Nadu',  total: 28, converted: 10, rate: 35.7 },
  { territory: 'Delhi NCR',   total: 25, converted: 11, rate: 44.0 },
  { territory: 'Telangana',   total: 18, converted:  7, rate: 38.9 },
  { territory: 'Gujarat',     total: 16, converted:  5, rate: 31.3 },
  { territory: 'Kerala',      total: 13, converted:  5, rate: 38.5 },
];

const DEMO_TOUCHPOINTS_TO_RESPONSE = [
  { bucket: '1',  count: 12 },
  { bucket: '2',  count: 22 },
  { bucket: '3',  count: 18 },
  { bucket: '4',  count: 11 },
  { bucket: '5+', count: 14 },
  { bucket: 'No response', count: 18 },
];

const DEMO_LEADS_AT_RISK = [
  { lead_id: 'demo-lead-1',  name: 'Dr. Anil Mehta (Glucanova)',    score: 92, owner_id: 'demo-user-id', days_idle: 12 },
  { lead_id: 'demo-lead-4',  name: 'Dr. Neha Gupta (Glucanova)',    score: 95, owner_id: 'demo-user-id', days_idle: 18 },
  { lead_id: 'demo-lead-7',  name: 'Dr. Manish Khanna (Oncevia)', score: 84, owner_id: 'demo-user-id', days_idle: 15 },
  { lead_id: 'demo-lead-10', name: 'Dr. Karan Verma (Migranova)',   score: 88, owner_id: 'demo-user-id', days_idle: 14 },
];

const DEMO_ANALYTICS_LAYOUT = {
  widgets: [
    { id: 'demo-wgt-1', widget_type: 'lead_velocity',         chart_type: 'line', config: {} },
    { id: 'demo-wgt-2', widget_type: 'stuck_leads',           chart_type: 'number', config: {} },
    { id: 'demo-wgt-3', widget_type: 'lead_aging',            chart_type: 'bar', config: {} },
    { id: 'demo-wgt-4', widget_type: 'won_reasons',           chart_type: 'horizontal-bar', config: {} },
    { id: 'demo-wgt-5', widget_type: 'leads_at_risk',         chart_type: 'table', config: {} },
    { id: 'demo-wgt-6', widget_type: 'score_band_conversion', chart_type: 'bar', config: {} },
  ],
  layouts: {
    lg: [
      { i: 'demo-wgt-1', x: 0, y: 0, w: 6, h: 4 },
      { i: 'demo-wgt-2', x: 6, y: 0, w: 3, h: 3 },
      { i: 'demo-wgt-3', x: 9, y: 0, w: 3, h: 4 },
      { i: 'demo-wgt-4', x: 0, y: 4, w: 6, h: 4 },
      { i: 'demo-wgt-5', x: 6, y: 4, w: 6, h: 5 },
      { i: 'demo-wgt-6', x: 0, y: 8, w: 6, h: 4 },
    ],
    md: [
      { i: 'demo-wgt-1', x: 0, y: 0,  w: 8, h: 4 },
      { i: 'demo-wgt-2', x: 0, y: 4,  w: 4, h: 3 },
      { i: 'demo-wgt-3', x: 4, y: 4,  w: 4, h: 4 },
      { i: 'demo-wgt-4', x: 0, y: 8,  w: 8, h: 4 },
      { i: 'demo-wgt-5', x: 0, y: 12, w: 8, h: 5 },
      { i: 'demo-wgt-6', x: 0, y: 17, w: 8, h: 4 },
    ],
    sm: [
      { i: 'demo-wgt-1', x: 0, y: 0,  w: 2, h: 4 },
      { i: 'demo-wgt-2', x: 0, y: 4,  w: 2, h: 3 },
      { i: 'demo-wgt-3', x: 0, y: 7,  w: 2, h: 4 },
      { i: 'demo-wgt-4', x: 0, y: 11, w: 2, h: 4 },
      { i: 'demo-wgt-5', x: 0, y: 15, w: 2, h: 5 },
      { i: 'demo-wgt-6', x: 0, y: 20, w: 2, h: 4 },
    ],
  },
};

const DEMO_OVERVIEW_LAYOUT = {
  widgets: [
    { id: 'demo-pin-1', widget_type: 'stuck_leads',   chart_type: 'number', config: {} },
    { id: 'demo-pin-2', widget_type: 'lead_velocity', chart_type: 'line',   config: {} },
  ],
  layouts: {
    lg: [
      { i: 'demo-pin-1', x: 0, y: 0, w: 6, h: 4 },
      { i: 'demo-pin-2', x: 6, y: 0, w: 6, h: 4 },
    ],
    md: [
      { i: 'demo-pin-1', x: 0, y: 0, w: 4, h: 4 },
      { i: 'demo-pin-2', x: 4, y: 0, w: 4, h: 4 },
    ],
    sm: [
      { i: 'demo-pin-1', x: 0, y: 0, w: 2, h: 4 },
      { i: 'demo-pin-2', x: 0, y: 4, w: 2, h: 4 },
    ],
  },
};

// Pharma is B2B (selling to HCPs and institutions). Relabel built-ins so the
// UI reads naturally for medical reps: "Lead" → HCP, "Deal" → Rx Opportunity.
const DEMO_CRM_SETTINGS = {
  business_type: 'b2b' as const,
  default_currency: 'INR',
  default_pipeline_id: 'demo-pipe',
  config: {
    field_overrides: {
      lead: {
        company:        { label: 'Hospital / Clinic', required: true,  visible: true },
        title:          { label: 'Specialty',         required: true,  visible: true },
        industry:       { label: 'Industry',          required: false, visible: false },
        date_of_birth:  { label: 'Date of Birth',     required: false, visible: false },
        gender:         { label: 'Gender',            required: false, visible: false },
      },
      deal: {
        name:   { label: 'Rx Opportunity',         required: true, visible: true },
        amount: { label: 'Annualized Rx Value',    required: true, visible: true },
      },
    },
    lead_scoring: {
      enabled: true,
      version: 2,
      grading: { A: 80, B: 60, C: 40, D: 0 },
      engagement_signals: { detail_visit: 10, sample_drop: 12, cme_attend: 15, trial_rx: 25 },
    },
    notifications: {
      email_enabled:    true,
      whatsapp_enabled: true,
      sms_enabled:      true,
    },
  },
};

const DEMO_CUSTOM_FIELDS = [
  { id: 'demo-cf-1', entity: 'lead', key: 'specialty',            label: 'Specialty',            type: 'select', options: ['Endocrinology','Oncology','Diabetology','Cardiology','Neurology','Rheumatology','General Medicine'], required: true,  visible: true, position: 0 },
  { id: 'demo-cf-2', entity: 'lead', key: 'product_interest',     label: 'Product Interest',     type: 'select', options: ['Glucanova','Diabextra','Insulora','Oncevia','Rheumolex','Migranova','Oncorib','Glyzentia'],            required: true,  visible: true, position: 1 },
  { id: 'demo-cf-3', entity: 'lead', key: 'monthly_rx_potential', label: 'Monthly Rx Potential', type: 'number', options: [],                                                                                                  required: false, visible: true, position: 2 },
  { id: 'demo-cf-4', entity: 'deal', key: 'therapy_area',         label: 'Therapy Area',         type: 'select', options: ['Diabetes','Oncology','Immunology','Neuroscience','Cardiovascular'],                                required: true,  visible: true, position: 0 },
  { id: 'demo-cf-5', entity: 'deal', key: 'samples_dispatched',   label: 'Samples Dispatched',   type: 'number', options: [],                                                                                                  required: false, visible: true, position: 1 },
];

const DEMO_AUTOMATIONS = [
  { id: 'demo-auto-1', name: 'Auto-assign high-potential HCPs to top MR', trigger: 'lead.created', conditions: { score_gte: 80 }, actions: [{ type: 'assign_to_user', user_id: 'demo-user-id' }], is_active: true, created_at: _now(-20) },
];
const DEMO_ASSIGNMENT_RULES = [
  { id: 'demo-rule-1', name: 'Round-robin by territory', strategy: 'round_robin', territory_id: 'demo-terr-1', user_ids: ['demo-user-id'], is_active: true, created_at: _now(-60) },
];

/**
 * The full pharmaceutical dataset, keyed to mirror the module-level consts in
 * demoCrm.ts so the middleware can destructure-shadow them.
 */
export const PHARMACEUTICAL_CRM = {
  LEADS,
  ACCOUNTS,
  CONTACTS,
  STAGES,
  PIPELINES,
  DEALS,
  ACTIVITIES,
  SOURCES,
  DEMO_DASHBOARD_SUMMARY,
  DEMO_PIPELINE_VALUE,
  DEMO_FUNNEL,
  DEMO_WIN_RATE_BY_REP,
  DEMO_FORECAST,
  DEMO_HEATMAP,
  DEMO_LEAD_SOURCE_ROI,
  DEMO_SCORE_DIST,
  DEMO_SALES_CYCLE,
  DEMO_DASHBOARD_COMPLETE,
  DEMO_TERRITORIES,
  DEMO_PRODUCTS,
  DEMO_CRM_SETTINGS,
  DEMO_CUSTOM_FIELDS,
  DEMO_AUTOMATIONS,
  DEMO_ASSIGNMENT_RULES,
  DEMO_ANALYTICS_LAYOUT,
  DEMO_OVERVIEW_LAYOUT,
  DEMO_LEAD_VELOCITY,
  DEMO_TIME_TO_FIRST_TOUCH,
  DEMO_STUCK_LEADS_KPI,
  DEMO_LOST_REASONS,
  DEMO_WON_REASONS,
  DEMO_DISQUAL_REASONS,
  DEMO_STAGE_CONVERSION,
  DEMO_LEAD_AGING,
  DEMO_COHORT_CONVERSION,
  DEMO_ENGAGEMENT_COMPARISON,
  DEMO_DAYS_SINCE_TOUCH,
  DEMO_SCORE_BAND_CONVERSION,
  DEMO_TERRITORY_CONVERSION,
  DEMO_TOUCHPOINTS_TO_RESPONSE,
  DEMO_LEADS_AT_RISK,
};
