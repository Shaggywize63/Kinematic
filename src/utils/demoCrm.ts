/**
 * Pre-canned CRM fixtures for the demo account (org_id=demo-org-999).
 * Mounted as middleware on /api/v1/crm so every list/analytics endpoint
 * returns visible data without needing rows in the DB.
 *
 * Mutations short-circuit to a success-shaped no-op so the demo can click
 * around without 500s; nothing persists.
 */
import { Request, Response, NextFunction } from 'express';
import { isDemo } from './demoData';

const REPS = ['Arjun Sharma', 'Priya Patel', 'Rahul Verma', 'Sneha Rao', 'Amit Singh'];

const LEADS = [
  { id: 'demo-lead-1',  first_name: 'Vikram', last_name: 'Reddy',  company: 'Skyline Developers', email: 'vikram.reddy@skyline.demo',  phone: '+91 98201 11111', status: 'qualified',  score: 88, score_grade: 'A', city: 'Bengaluru', industry: 'Real Estate',     source_id: 'demo-src-1', owner_id: 'demo-user-id', owner_name: REPS[0], last_activity_at: new Date(Date.now() - 86400000).toISOString(),       created_at: new Date(Date.now() - 14*86400000).toISOString() },
  { id: 'demo-lead-2',  first_name: 'Anjali', last_name: 'Iyer',   company: 'Zenith Properties',   email: 'anjali@zenith.demo',         phone: '+91 98202 22222', status: 'working',    score: 76, score_grade: 'A', city: 'Mumbai',    industry: 'Construction',    source_id: 'demo-src-2', owner_id: 'demo-user-id', owner_name: REPS[1], last_activity_at: new Date(Date.now() - 2*86400000).toISOString(),     created_at: new Date(Date.now() - 21*86400000).toISOString() },
  { id: 'demo-lead-3',  first_name: 'Rohan',  last_name: 'Kumar',  company: 'Acme Steel',          email: 'rohan@acme.demo',            phone: '+91 98203 33333', status: 'new',        score: 64, score_grade: 'B', city: 'Pune',      industry: 'Steel',           source_id: 'demo-src-1', owner_id: 'demo-user-id', owner_name: REPS[2], last_activity_at: new Date(Date.now() - 4*86400000).toISOString(),     created_at: new Date(Date.now() - 7*86400000).toISOString() },
  { id: 'demo-lead-4',  first_name: 'Neha',   last_name: 'Gupta',  company: 'Vega Infra',          email: 'neha@vegainfra.demo',        phone: '+91 98204 44444', status: 'qualified',  score: 92, score_grade: 'A', city: 'Hyderabad', industry: 'Infrastructure',  source_id: 'demo-src-3', owner_id: 'demo-user-id', owner_name: REPS[0], last_activity_at: new Date(Date.now() - 86400000).toISOString(),       created_at: new Date(Date.now() - 30*86400000).toISOString() },
  { id: 'demo-lead-5',  first_name: 'Karthik',last_name: 'Pillai', company: 'Trident Power',       email: 'karthik@tridentpower.demo',  phone: '+91 98205 55555', status: 'working',    score: 55, score_grade: 'B', city: 'Chennai',   industry: 'Energy',          source_id: 'demo-src-4', owner_id: 'demo-user-id', owner_name: REPS[3], last_activity_at: new Date(Date.now() - 5*86400000).toISOString(),     created_at: new Date(Date.now() - 18*86400000).toISOString() },
  { id: 'demo-lead-6',  first_name: 'Pooja',  last_name: 'Joshi',  company: 'Lakshmi Builders',    email: 'pooja@lakshmibuild.demo',    phone: '+91 98206 66666', status: 'unqualified',score: 22, score_grade: 'D', city: 'Jaipur',    industry: 'Real Estate',     source_id: 'demo-src-5', owner_id: 'demo-user-id', owner_name: REPS[4], last_activity_at: new Date(Date.now() - 9*86400000).toISOString(),     created_at: new Date(Date.now() - 35*86400000).toISOString() },
  { id: 'demo-lead-7',  first_name: 'Manish', last_name: 'Khanna', company: 'Konkan Steel',        email: 'manish@konkansteel.demo',    phone: '+91 98207 77777', status: 'qualified',  score: 81, score_grade: 'A', city: 'Mumbai',    industry: 'Steel',           source_id: 'demo-src-2', owner_id: 'demo-user-id', owner_name: REPS[1], last_activity_at: new Date(Date.now() - 3*86400000).toISOString(),     created_at: new Date(Date.now() - 25*86400000).toISOString() },
  { id: 'demo-lead-8',  first_name: 'Ishaan', last_name: 'Bose',   company: 'Falcon Engineering',  email: 'ishaan@falconeng.demo',      phone: '+91 98208 88888', status: 'nurturing',  score: 48, score_grade: 'C', city: 'Kolkata',   industry: 'Manufacturing',   source_id: 'demo-src-3', owner_id: 'demo-user-id', owner_name: REPS[2], last_activity_at: new Date(Date.now() - 12*86400000).toISOString(),    created_at: new Date(Date.now() - 42*86400000).toISOString() },
  { id: 'demo-lead-9',  first_name: 'Tanvi',  last_name: 'Mehta',  company: 'Pragati Industries',  email: 'tanvi@pragati.demo',         phone: '+91 98209 99999', status: 'new',        score: 70, score_grade: 'B', city: 'Ahmedabad', industry: 'Manufacturing',   source_id: 'demo-src-1', owner_id: 'demo-user-id', owner_name: REPS[3], last_activity_at: new Date(Date.now() - 86400000).toISOString(),       created_at: new Date(Date.now() - 5*86400000).toISOString() },
  { id: 'demo-lead-10', first_name: 'Karan',  last_name: 'Verma',  company: 'Suryadev Cement',     email: 'karan@suryadev.demo',        phone: '+91 98210 10101', status: 'working',    score: 84, score_grade: 'A', city: 'Surat',     industry: 'Cement',          source_id: 'demo-src-4', owner_id: 'demo-user-id', owner_name: REPS[0], last_activity_at: new Date(Date.now() - 2*86400000).toISOString(),     created_at: new Date(Date.now() - 11*86400000).toISOString() },
  { id: 'demo-lead-11', first_name: 'Aditya', last_name: 'Nair',   company: 'Helios Constructions',email: 'aditya@helios.demo',         phone: '+91 98211 12121', status: 'qualified',  score: 78, score_grade: 'A', city: 'Delhi',     industry: 'Construction',    source_id: 'demo-src-5', owner_id: 'demo-user-id', owner_name: REPS[1], last_activity_at: new Date(Date.now() - 86400000).toISOString(),       created_at: new Date(Date.now() - 28*86400000).toISOString() },
  { id: 'demo-lead-12', first_name: 'Diya',   last_name: 'Kapoor', company: 'Coromandel Logistics',email: 'diya@coromandel.demo',       phone: '+91 98212 13131', status: 'new',        score: 36, score_grade: 'C', city: 'Chennai',   industry: 'Logistics',       source_id: 'demo-src-2', owner_id: 'demo-user-id', owner_name: REPS[2], last_activity_at: new Date(Date.now() - 6*86400000).toISOString(),     created_at: new Date(Date.now() - 9*86400000).toISOString() },
];

const ACCOUNTS = [
  { id: 'demo-acct-1', name: 'Skyline Developers',     domain: 'skyline.demo',       industry: 'Real Estate',    annual_revenue: 1850000000, owner_id: 'demo-user-id', owner_name: REPS[0], created_at: new Date(Date.now() - 60*86400000).toISOString() },
  { id: 'demo-acct-2', name: 'Zenith Properties',      domain: 'zenith.demo',        industry: 'Construction',   annual_revenue: 2100000000, owner_id: 'demo-user-id', owner_name: REPS[1], created_at: new Date(Date.now() - 90*86400000).toISOString() },
  { id: 'demo-acct-3', name: 'Acme Steel',             domain: 'acme.demo',          industry: 'Steel',          annual_revenue: 980000000,  owner_id: 'demo-user-id', owner_name: REPS[2], created_at: new Date(Date.now() - 45*86400000).toISOString() },
  { id: 'demo-acct-4', name: 'Vega Infra',             domain: 'vegainfra.demo',     industry: 'Infrastructure', annual_revenue: 3200000000, owner_id: 'demo-user-id', owner_name: REPS[0], created_at: new Date(Date.now() - 120*86400000).toISOString() },
  { id: 'demo-acct-5', name: 'Trident Power',          domain: 'tridentpower.demo',  industry: 'Energy',         annual_revenue: 1450000000, owner_id: 'demo-user-id', owner_name: REPS[3], created_at: new Date(Date.now() - 75*86400000).toISOString() },
  { id: 'demo-acct-6', name: 'Suryadev Cement',        domain: 'suryadev.demo',      industry: 'Cement',         annual_revenue: 870000000,  owner_id: 'demo-user-id', owner_name: REPS[4], created_at: new Date(Date.now() - 30*86400000).toISOString() },
  { id: 'demo-acct-7', name: 'Helios Constructions',   domain: 'helios.demo',        industry: 'Construction',   annual_revenue: 1200000000, owner_id: 'demo-user-id', owner_name: REPS[1], created_at: new Date(Date.now() - 150*86400000).toISOString() },
  { id: 'demo-acct-8', name: 'Konkan Steel',           domain: 'konkansteel.demo',   industry: 'Steel',          annual_revenue: 760000000,  owner_id: 'demo-user-id', owner_name: REPS[2], created_at: new Date(Date.now() - 100*86400000).toISOString() },
];

const CONTACTS = [
  { id: 'demo-ctc-1', first_name: 'Vikram',  last_name: 'Reddy',  email: 'vikram.reddy@skyline.demo',  phone: '+91 98201 11111', title: 'VP Procurement',     account_id: 'demo-acct-1', account_name: 'Skyline Developers',   owner_id: 'demo-user-id', owner_name: REPS[0] },
  { id: 'demo-ctc-2', first_name: 'Anjali',  last_name: 'Iyer',   email: 'anjali@zenith.demo',         phone: '+91 98202 22222', title: 'Director Materials', account_id: 'demo-acct-2', account_name: 'Zenith Properties',    owner_id: 'demo-user-id', owner_name: REPS[1] },
  { id: 'demo-ctc-3', first_name: 'Rohan',   last_name: 'Kumar',  email: 'rohan@acme.demo',            phone: '+91 98203 33333', title: 'GM Operations',      account_id: 'demo-acct-3', account_name: 'Acme Steel',           owner_id: 'demo-user-id', owner_name: REPS[2] },
  { id: 'demo-ctc-4', first_name: 'Neha',    last_name: 'Gupta',  email: 'neha@vegainfra.demo',        phone: '+91 98204 44444', title: 'Head of Procurement',account_id: 'demo-acct-4', account_name: 'Vega Infra',           owner_id: 'demo-user-id', owner_name: REPS[0] },
  { id: 'demo-ctc-5', first_name: 'Karthik', last_name: 'Pillai', email: 'karthik@tridentpower.demo',  phone: '+91 98205 55555', title: 'Project Manager',    account_id: 'demo-acct-5', account_name: 'Trident Power',        owner_id: 'demo-user-id', owner_name: REPS[3] },
  { id: 'demo-ctc-6', first_name: 'Karan',   last_name: 'Verma',  email: 'karan@suryadev.demo',        phone: '+91 98210 10101', title: 'Founder',            account_id: 'demo-acct-6', account_name: 'Suryadev Cement',      owner_id: 'demo-user-id', owner_name: REPS[0] },
  { id: 'demo-ctc-7', first_name: 'Aditya',  last_name: 'Nair',   email: 'aditya@helios.demo',         phone: '+91 98211 12121', title: 'Site Engineer',      account_id: 'demo-acct-7', account_name: 'Helios Constructions', owner_id: 'demo-user-id', owner_name: REPS[1] },
  { id: 'demo-ctc-8', first_name: 'Manish',  last_name: 'Khanna', email: 'manish@konkansteel.demo',    phone: '+91 98207 77777', title: 'VP Sales',           account_id: 'demo-acct-8', account_name: 'Konkan Steel',         owner_id: 'demo-user-id', owner_name: REPS[2] },
];

const STAGES = [
  { id: 'demo-stg-1', pipeline_id: 'demo-pipe', name: 'Discovery',     position: 0, probability: 10, stage_type: 'open', color: '#94a3b8' },
  { id: 'demo-stg-2', pipeline_id: 'demo-pipe', name: 'Qualification', position: 1, probability: 25, stage_type: 'open', color: '#60a5fa' },
  { id: 'demo-stg-3', pipeline_id: 'demo-pipe', name: 'Proposal',      position: 2, probability: 50, stage_type: 'open', color: '#a78bfa' },
  { id: 'demo-stg-4', pipeline_id: 'demo-pipe', name: 'Negotiation',   position: 3, probability: 75, stage_type: 'open', color: '#fbbf24' },
  { id: 'demo-stg-5', pipeline_id: 'demo-pipe', name: 'Closed Won',    position: 4, probability: 100,stage_type: 'won',  color: '#22c55e' },
  { id: 'demo-stg-6', pipeline_id: 'demo-pipe', name: 'Closed Lost',   position: 5, probability: 0,  stage_type: 'lost', color: '#ef4444' },
];

const PIPELINES = [{ id: 'demo-pipe', name: 'Sales', is_default: true, stages: STAGES }];

const DEALS = [
  { id: 'demo-deal-1',  name: 'Skyline Mumbai Tower – Steel',    account_id: 'demo-acct-1', account_name: 'Skyline Developers',     pipeline_id: 'demo-pipe', stage_id: 'demo-stg-3', stage_name: 'Proposal',      stage_type: 'open', status: 'open', amount: 7250000,  currency: 'INR', probability: 50, win_probability_ai: 62, owner_id: 'demo-user-id', owner_name: REPS[0], expected_close_date: new Date(Date.now() + 12*86400000).toISOString().slice(0,10), created_at: new Date(Date.now() - 30*86400000).toISOString() },
  { id: 'demo-deal-2',  name: 'Zenith Pune Hi-Rise – Cement',    account_id: 'demo-acct-2', account_name: 'Zenith Properties',      pipeline_id: 'demo-pipe', stage_id: 'demo-stg-4', stage_name: 'Negotiation',   stage_type: 'open', status: 'open', amount: 12400000, currency: 'INR', probability: 75, win_probability_ai: 78, owner_id: 'demo-user-id', owner_name: REPS[1], expected_close_date: new Date(Date.now() + 6*86400000).toISOString().slice(0,10),  created_at: new Date(Date.now() - 45*86400000).toISOString() },
  { id: 'demo-deal-3',  name: 'Acme TMT Bars – Q3 Restock',      account_id: 'demo-acct-3', account_name: 'Acme Steel',             pipeline_id: 'demo-pipe', stage_id: 'demo-stg-2', stage_name: 'Qualification', stage_type: 'open', status: 'open', amount: 3800000,  currency: 'INR', probability: 25, win_probability_ai: 35, owner_id: 'demo-user-id', owner_name: REPS[2], expected_close_date: new Date(Date.now() + 28*86400000).toISOString().slice(0,10), created_at: new Date(Date.now() - 14*86400000).toISOString() },
  { id: 'demo-deal-4',  name: 'Vega Highway Project – Steel',    account_id: 'demo-acct-4', account_name: 'Vega Infra',             pipeline_id: 'demo-pipe', stage_id: 'demo-stg-3', stage_name: 'Proposal',      stage_type: 'open', status: 'open', amount: 18500000, currency: 'INR', probability: 50, win_probability_ai: 71, owner_id: 'demo-user-id', owner_name: REPS[0], expected_close_date: new Date(Date.now() + 18*86400000).toISOString().slice(0,10), created_at: new Date(Date.now() - 50*86400000).toISOString() },
  { id: 'demo-deal-5',  name: 'Trident Substation – GI Wire',    account_id: 'demo-acct-5', account_name: 'Trident Power',          pipeline_id: 'demo-pipe', stage_id: 'demo-stg-1', stage_name: 'Discovery',     stage_type: 'open', status: 'open', amount: 2150000,  currency: 'INR', probability: 10, win_probability_ai: 22, owner_id: 'demo-user-id', owner_name: REPS[3], expected_close_date: new Date(Date.now() + 35*86400000).toISOString().slice(0,10), created_at: new Date(Date.now() - 8*86400000).toISOString() },
  { id: 'demo-deal-6',  name: 'Suryadev OPC Cement – Annual',    account_id: 'demo-acct-6', account_name: 'Suryadev Cement',        pipeline_id: 'demo-pipe', stage_id: 'demo-stg-4', stage_name: 'Negotiation',   stage_type: 'open', status: 'open', amount: 9800000,  currency: 'INR', probability: 75, win_probability_ai: 80, owner_id: 'demo-user-id', owner_name: REPS[4], expected_close_date: new Date(Date.now() + 4*86400000).toISOString().slice(0,10),  created_at: new Date(Date.now() - 22*86400000).toISOString() },
  { id: 'demo-deal-7',  name: 'Helios Mumbai Phase 2',           account_id: 'demo-acct-7', account_name: 'Helios Constructions',   pipeline_id: 'demo-pipe', stage_id: 'demo-stg-2', stage_name: 'Qualification', stage_type: 'open', status: 'open', amount: 5400000,  currency: 'INR', probability: 25, win_probability_ai: 40, owner_id: 'demo-user-id', owner_name: REPS[1], expected_close_date: new Date(Date.now() + 22*86400000).toISOString().slice(0,10), created_at: new Date(Date.now() - 10*86400000).toISOString() },
  { id: 'demo-deal-8',  name: 'Konkan TMT 16mm Pilot',           account_id: 'demo-acct-8', account_name: 'Konkan Steel',           pipeline_id: 'demo-pipe', stage_id: 'demo-stg-1', stage_name: 'Discovery',     stage_type: 'open', status: 'open', amount: 1750000,  currency: 'INR', probability: 10, win_probability_ai: 18, owner_id: 'demo-user-id', owner_name: REPS[2], expected_close_date: new Date(Date.now() + 40*86400000).toISOString().slice(0,10), created_at: new Date(Date.now() - 5*86400000).toISOString() },
  { id: 'demo-deal-9',  name: 'Skyline – Bengaluru Tower',       account_id: 'demo-acct-1', account_name: 'Skyline Developers',     pipeline_id: 'demo-pipe', stage_id: 'demo-stg-5', stage_name: 'Closed Won',    stage_type: 'won',  status: 'won',  amount: 14200000, currency: 'INR', probability: 100,win_probability_ai: 100,owner_id: 'demo-user-id', owner_name: REPS[0], actual_close_date: new Date(Date.now() - 3*86400000).toISOString().slice(0,10),    created_at: new Date(Date.now() - 65*86400000).toISOString() },
  { id: 'demo-deal-10', name: 'Vega Highway Phase 1 – Cement',   account_id: 'demo-acct-4', account_name: 'Vega Infra',             pipeline_id: 'demo-pipe', stage_id: 'demo-stg-5', stage_name: 'Closed Won',    stage_type: 'won',  status: 'won',  amount: 22600000, currency: 'INR', probability: 100,win_probability_ai: 100,owner_id: 'demo-user-id', owner_name: REPS[0], actual_close_date: new Date(Date.now() - 12*86400000).toISOString().slice(0,10),   created_at: new Date(Date.now() - 80*86400000).toISOString() },
  { id: 'demo-deal-11', name: 'Suryadev Demo Pilot',             account_id: 'demo-acct-6', account_name: 'Suryadev Cement',        pipeline_id: 'demo-pipe', stage_id: 'demo-stg-5', stage_name: 'Closed Won',    stage_type: 'won',  status: 'won',  amount: 4300000,  currency: 'INR', probability: 100,win_probability_ai: 100,owner_id: 'demo-user-id', owner_name: REPS[4], actual_close_date: new Date(Date.now() - 25*86400000).toISOString().slice(0,10),   created_at: new Date(Date.now() - 50*86400000).toISOString() },
  { id: 'demo-deal-12', name: 'Helios Pune Site Closeout',       account_id: 'demo-acct-7', account_name: 'Helios Constructions',   pipeline_id: 'demo-pipe', stage_id: 'demo-stg-5', stage_name: 'Closed Won',    stage_type: 'won',  status: 'won',  amount: 6750000,  currency: 'INR', probability: 100,win_probability_ai: 100,owner_id: 'demo-user-id', owner_name: REPS[1], actual_close_date: new Date(Date.now() - 38*86400000).toISOString().slice(0,10),   created_at: new Date(Date.now() - 75*86400000).toISOString() },
  { id: 'demo-deal-13', name: 'Trident – lost to Tata',          account_id: 'demo-acct-5', account_name: 'Trident Power',          pipeline_id: 'demo-pipe', stage_id: 'demo-stg-6', stage_name: 'Closed Lost',   stage_type: 'lost', status: 'lost', amount: 3200000,  currency: 'INR', probability: 0,  win_probability_ai: 0,  owner_id: 'demo-user-id', owner_name: REPS[3], actual_close_date: new Date(Date.now() - 18*86400000).toISOString().slice(0,10), lost_reason: 'Competitor', created_at: new Date(Date.now() - 60*86400000).toISOString() },
  { id: 'demo-deal-14', name: 'Acme – budget cut',               account_id: 'demo-acct-3', account_name: 'Acme Steel',             pipeline_id: 'demo-pipe', stage_id: 'demo-stg-6', stage_name: 'Closed Lost',   stage_type: 'lost', status: 'lost', amount: 2800000,  currency: 'INR', probability: 0,  win_probability_ai: 0,  owner_id: 'demo-user-id', owner_name: REPS[2], actual_close_date: new Date(Date.now() - 30*86400000).toISOString().slice(0,10), lost_reason: 'No budget',  created_at: new Date(Date.now() - 70*86400000).toISOString() },
];

const ACTIVITIES = [
  { id: 'demo-act-1',  type: 'call',    subject: 'Discovery call with Vikram',  status: 'completed', completed_at: new Date(Date.now() - 86400000).toISOString(),    lead_id: 'demo-lead-1', deal_id: null,           assigned_to: 'demo-user-id', assigned_to_name: REPS[0] },
  { id: 'demo-act-2',  type: 'email',   subject: 'Pricing sent to Anjali',      status: 'completed', completed_at: new Date(Date.now() - 2*86400000).toISOString(),  lead_id: 'demo-lead-2', deal_id: null,           assigned_to: 'demo-user-id', assigned_to_name: REPS[1] },
  { id: 'demo-act-3',  type: 'meeting', subject: 'Site visit – Skyline Tower',  status: 'completed', completed_at: new Date(Date.now() - 3*86400000).toISOString(),  lead_id: null,          deal_id: 'demo-deal-1',  assigned_to: 'demo-user-id', assigned_to_name: REPS[0] },
  { id: 'demo-act-4',  type: 'note',    subject: 'Decision-maker change at Vega',status:'completed', completed_at: new Date(Date.now() - 5*86400000).toISOString(),  lead_id: null,          deal_id: 'demo-deal-4',  assigned_to: 'demo-user-id', assigned_to_name: REPS[0] },
  { id: 'demo-act-5',  type: 'call',    subject: 'Follow-up with Rohan',        status: 'completed', completed_at: new Date(Date.now() - 4*86400000).toISOString(),  lead_id: 'demo-lead-3', deal_id: null,           assigned_to: 'demo-user-id', assigned_to_name: REPS[2] },
  { id: 'demo-act-6',  type: 'task',    subject: 'Send proposal to Trident',    status: 'planned',   due_at: new Date(Date.now() + 2*86400000).toISOString(),         lead_id: null,          deal_id: 'demo-deal-5',  assigned_to: 'demo-user-id', assigned_to_name: REPS[3] },
  { id: 'demo-act-7',  type: 'call',    subject: 'Negotiate with Suryadev',     status: 'completed', completed_at: new Date(Date.now() - 86400000).toISOString(),    lead_id: null,          deal_id: 'demo-deal-6',  assigned_to: 'demo-user-id', assigned_to_name: REPS[4] },
  { id: 'demo-act-8',  type: 'email',   subject: 'Intro deck to Karthik',       status: 'completed', completed_at: new Date(Date.now() - 6*86400000).toISOString(),  lead_id: 'demo-lead-5', deal_id: null,           assigned_to: 'demo-user-id', assigned_to_name: REPS[3] },
  { id: 'demo-act-9',  type: 'meeting', subject: 'Quarterly review – Helios',   status: 'completed', completed_at: new Date(Date.now() - 8*86400000).toISOString(),  lead_id: null,          deal_id: 'demo-deal-7',  assigned_to: 'demo-user-id', assigned_to_name: REPS[1] },
  { id: 'demo-act-10', type: 'task',    subject: 'Quote for Acme TMT',          status: 'planned',   due_at: new Date(Date.now() + 86400000).toISOString(),           lead_id: null,          deal_id: 'demo-deal-3',  assigned_to: 'demo-user-id', assigned_to_name: REPS[2] },
  { id: 'demo-act-11', type: 'call',    subject: 'Cold outreach – Tanvi',       status: 'completed', completed_at: new Date(Date.now() - 86400000).toISOString(),    lead_id: 'demo-lead-9', deal_id: null,           assigned_to: 'demo-user-id', assigned_to_name: REPS[3] },
  { id: 'demo-act-12', type: 'note',    subject: 'Konkan asked for samples',    status: 'completed', completed_at: new Date(Date.now() - 9*86400000).toISOString(),  lead_id: 'demo-lead-7', deal_id: null,           assigned_to: 'demo-user-id', assigned_to_name: REPS[1] },
];

const SOURCES = [
  { id: 'demo-src-1', name: 'Website',       cost_per_lead: 250, is_active: true },
  { id: 'demo-src-2', name: 'Referral',      cost_per_lead: 0,   is_active: true },
  { id: 'demo-src-3', name: 'Trade Show',    cost_per_lead: 800, is_active: true },
  { id: 'demo-src-4', name: 'Cold Outreach', cost_per_lead: 100, is_active: true },
  { id: 'demo-src-5', name: 'LinkedIn Ads',  cost_per_lead: 450, is_active: true },
];

// Analytics payloads ----------------------------------------------------

const DEMO_DASHBOARD_SUMMARY = {
  total_leads: LEADS.length,
  new_leads:        LEADS.filter(l => l.status === 'new').length,
  qualified_leads:  LEADS.filter(l => l.status === 'qualified').length,
  converted_leads:  4,
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
  { stage: 'New',         count: 12, value: 4_800_000  },
  { stage: 'Qualified',   count: 9,  value: 18_500_000 },
  { stage: 'Proposal',    count: 6,  value: 31_550_000 },
  { stage: 'Negotiation', count: 4,  value: 22_400_000 },
  { stage: 'Won',         count: 4,  value: 47_850_000 },
];

const DEMO_WIN_RATE_BY_REP = REPS.map((name, i) => ({
  rep_id: 'demo-user-id', rep_name: name,
  won: 5 - i, lost: i, total_closed: 5 - i + i,
  win_rate: Math.max(0, Math.round((5 - i) / Math.max(1, 5) * 100)),
  revenue: [22_600_000, 14_200_000, 6_750_000, 4_300_000, 0][i] || 0,
}));

const DEMO_FORECAST = (() => {
  const now = new Date();
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    return {
      period: d.toISOString().slice(0, 7),
      committed:  3_500_000 + i * 800_000,
      best_case:  6_400_000 + i * 1_400_000,
      pipeline:  12_800_000 + i * 1_600_000,
      target:    10_000_000,
    };
  });
})();

const DEMO_HEATMAP = (() => {
  const dows = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const out: Array<{ dow: string; hour: number; count: number }> = [];
  for (const dow of dows) {
    for (let h = 8; h < 20; h++) {
      const peak = dow !== 'Sun' && h >= 10 && h <= 17;
      out.push({ dow, hour: h, count: peak ? Math.round(3 + Math.random() * 12) : Math.round(Math.random() * 3) });
    }
  }
  return out;
})();

const DEMO_LEAD_SOURCE_ROI = SOURCES.map((s, i) => ({
  source_id: s.id, source_name: s.name,
  leads:    [12, 8,  4, 14, 6][i],
  qualified:[5,  6,  3,  4, 2][i],
  won:      [3,  4,  2,  1, 1][i],
  cost:     [12*s.cost_per_lead, 0, 4*s.cost_per_lead, 14*s.cost_per_lead, 6*s.cost_per_lead][i],
  revenue:  [22_600_000, 14_200_000, 6_750_000, 4_300_000, 0][i] || 0,
}));

const DEMO_SCORE_DIST = [
  { bucket: '0-20',   count: 4 },
  { bucket: '21-40',  count: 7 },
  { bucket: '41-60',  count: 9 },
  { bucket: '61-80',  count: 14 },
  { bucket: '81-100', count: 10 },
];

const DEMO_SALES_CYCLE = [
  { stage: 'Discovery',     avg_days: 4 },
  { stage: 'Qualification', avg_days: 7 },
  { stage: 'Proposal',      avg_days: 11 },
  { stage: 'Negotiation',   avg_days: 8 },
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

// Lookups for filters
const DEMO_TERRITORIES = [
  { id: 'demo-terr-1', name: 'Mumbai West',  is_active: true },
  { id: 'demo-terr-2', name: 'Bangalore North', is_active: true },
  { id: 'demo-terr-3', name: 'Delhi Central', is_active: true },
];
const DEMO_PRODUCTS = [
  { id: 'demo-prod-1', name: 'TMT Bar 8mm',  sku: 'TMT-8',  unit_price: 65,  unit: 'kg', is_active: true },
  { id: 'demo-prod-2', name: 'TMT Bar 12mm', sku: 'TMT-12', unit_price: 64,  unit: 'kg', is_active: true },
  { id: 'demo-prod-3', name: 'TMT Bar 16mm', sku: 'TMT-16', unit_price: 63,  unit: 'kg', is_active: true },
  { id: 'demo-prod-4', name: 'OPC Cement 53', sku: 'CEM-OPC53', unit_price: 410, unit: 'bag', is_active: true },
  { id: 'demo-prod-5', name: 'GI Wire 8 SWG', sku: 'GI-8',   unit_price: 92,  unit: 'kg', is_active: true },
];

// --------------------------------------------------------------------

const json = (res: Response, body: unknown) => res.json(body);
const list = <T,>(rows: T[]) => ({ data: rows, total: rows.length, limit: rows.length, offset: 0 });
const ok = <T,>(body: T) => body;

export function demoCrmMiddleware(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: { org_id?: string } }).user;
  if (!isDemo(user)) return next();

  const path = req.path; // already relative to /api/v1/crm because router.use mounts the middleware on the crm router
  const method = req.method;

  if (method === 'GET') {
    // Lists
    if (path === '/leads')     { json(res, list(LEADS));     return; }
    if (path === '/deals')     { json(res, list(DEALS));     return; }
    if (path === '/accounts')  { json(res, list(ACCOUNTS));  return; }
    if (path === '/contacts')  { json(res, list(CONTACTS));  return; }
    if (path === '/activities'){ json(res, list(ACTIVITIES));return; }
    if (path === '/tasks')     { json(res, list(ACTIVITIES.filter(a => a.type === 'task'))); return; }
    if (path === '/pipelines') { json(res, ok(PIPELINES));   return; }
    if (path === '/lead-sources')   { json(res, list(SOURCES));         return; }
    if (path === '/territories')    { json(res, list(DEMO_TERRITORIES));return; }
    if (path === '/products')       { json(res, list(DEMO_PRODUCTS));   return; }
    if (path === '/email-templates'){ json(res, list([]));              return; }
    if (path === '/whatsapp-templates'){ json(res, list([]));           return; }
    if (path === '/automations')    { json(res, list([]));              return; }
    if (path === '/assignment-rules'){ json(res, list([]));             return; }
    if (path === '/custom-fields')  { json(res, list([]));              return; }
    if (path === '/settings')       { json(res, ok({})); return; }

    // Singletons by id
    const leadM = path.match(/^\/leads\/([^/]+)$/);
    if (leadM) { const r = LEADS.find(l => l.id === leadM[1]); json(res, r || LEADS[0]); return; }
    const dealM = path.match(/^\/deals\/([^/]+)$/);
    if (dealM) { const r = DEALS.find(d => d.id === dealM[1]); json(res, r || DEALS[0]); return; }
    const acctM = path.match(/^\/accounts\/([^/]+)$/);
    if (acctM) { const r = ACCOUNTS.find(a => a.id === acctM[1]); json(res, r || ACCOUNTS[0]); return; }
    const ctcM  = path.match(/^\/contacts\/([^/]+)$/);
    if (ctcM)  { const r = CONTACTS.find(c => c.id === ctcM[1]);  json(res, r || CONTACTS[0]); return; }

    // Lead/deal/account sub-resources
    if (/^\/leads\/[^/]+\/activities$/.test(path))   { json(res, list(ACTIVITIES.slice(0, 4)));  return; }
    if (/^\/leads\/[^/]+\/deals$/.test(path))        { json(res, list(DEALS.slice(0, 2)));        return; }
    if (/^\/leads\/[^/]+\/score-history$/.test(path)){ json(res, list([])); return; }
    if (/^\/deals\/[^/]+\/(activities|history|contacts|notes|line-items)$/.test(path)) {
      json(res, list([])); return;
    }
    if (/^\/accounts\/[^/]+\/(contacts|deals|activities|notes)$/.test(path)) {
      const which = path.split('/').pop();
      if (which === 'contacts')   { json(res, list(CONTACTS.slice(0, 3))); return; }
      if (which === 'deals')      { json(res, list(DEALS.slice(0, 3)));    return; }
      if (which === 'activities') { json(res, list(ACTIVITIES.slice(0, 3)));return; }
      json(res, list([])); return;
    }
    if (/^\/contacts\/[^/]+\/(activities|deals|notes|emails)$/.test(path)) {
      json(res, list([])); return;
    }

    // Analytics
    if (path === '/analytics/dashboard-complete')      { json(res, DEMO_DASHBOARD_COMPLETE); return; }
    if (path === '/analytics/dashboard-summary')       { json(res, DEMO_DASHBOARD_SUMMARY);  return; }
    if (path === '/analytics/pipeline-value')          { json(res, DEMO_PIPELINE_VALUE);     return; }
    if (path === '/analytics/funnel')                  { json(res, DEMO_FUNNEL);             return; }
    if (path === '/analytics/win-rate')                { json(res, DEMO_WIN_RATE_BY_REP);    return; }
    if (path === '/analytics/sales-cycle')             { json(res, DEMO_SALES_CYCLE);        return; }
    if (path === '/analytics/forecast')                { json(res, DEMO_FORECAST);           return; }
    if (path === '/analytics/activity-heatmap')        { json(res, DEMO_HEATMAP);            return; }
    if (path === '/analytics/lead-source-roi')         { json(res, DEMO_LEAD_SOURCE_ROI);    return; }
    if (path === '/analytics/lead-score-distribution') { json(res, DEMO_SCORE_DIST);         return; }
    if (path === '/analytics/by-state')                { json(res, list([])); return; }
  }

  // Mutations: pretend-success no-op so the demo can click around without 500s.
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    if (method === 'DELETE') { res.status(204).end(); return; }
    res.status(method === 'POST' ? 201 : 200).json({ id: 'demo-noop-' + Math.random().toString(36).slice(2, 8), ok: true, demo: true });
    return;
  }

  return next();
}
