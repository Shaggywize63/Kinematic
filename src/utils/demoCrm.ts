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
import { currentDemoIndustry } from '../lib/demoContext';
import { INSURANCE_CRM } from './demo/insuranceCrm';
import { PHARMACEUTICAL_CRM } from './demo/pharmaceuticalCrm';

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

// ── Extended analytics (15 widgets for the customisable Lead Analytics page) ──

const DEMO_LEAD_VELOCITY = (() => {
  const now = new Date();
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    const total = 35 + i * 6;
    const qualified = Math.round(total * (0.35 + i * 0.03));
    const prev = i === 0 ? null : Math.round((35 + (i - 1) * 6) * (0.35 + (i - 1) * 0.03));
    const mom = prev == null ? null : Math.round(((qualified - prev) / prev) * 1000) / 10;
    return { month: d.toISOString().slice(0, 7), total, qualified, mom_growth_pct: mom };
  });
})();

const DEMO_TIME_TO_FIRST_TOUCH = {
  avg_minutes: 42,
  median_minutes: 28,
  sla_breach_pct: 18.5,
  total: 124,
  breaches: 23,
  sla_minutes: 60,
  distribution: [
    { bucket: '<5m',    count: 22 },
    { bucket: '5–15m',  count: 38 },
    { bucket: '15–60m', count: 41 },
    { bucket: '1–4h',   count: 14 },
    { bucket: '4–24h',  count: 7 },
    { bucket: '>24h',   count: 2 },
  ],
};

const DEMO_STUCK_LEADS_KPI = {
  count_7d: 18,
  count_14d: 9,
  count_30d: 4,
  top_owners: [
    { owner_id: 'demo-user-id', count: 5 },
    { owner_id: 'demo-user-2',  count: 3 },
    { owner_id: 'demo-user-3',  count: 1 },
  ],
};

const DEMO_LOST_REASONS = [
  { reason: 'Price too high',    count: 14 },
  { reason: 'Chose competitor',  count: 11 },
  { reason: 'No budget',         count: 9 },
  { reason: 'Bad timing',        count: 6 },
  { reason: 'Lost contact',      count: 4 },
  { reason: 'Project cancelled', count: 3 },
];

const DEMO_WON_REASONS = [
  { reason: 'Better pricing',         count: 12 },
  { reason: 'Faster delivery',        count: 9 },
  { reason: 'Existing relationship',  count: 7 },
  { reason: 'Better product quality', count: 5 },
  { reason: 'Local support',          count: 3 },
];

const DEMO_DISQUAL_REASONS = [
  { reason: 'Not in service area', count: 8 },
  { reason: 'Below min order qty', count: 6 },
  { reason: 'Wrong industry',      count: 4 },
  { reason: 'No authority',        count: 3 },
];

const DEMO_STAGE_CONVERSION = [
  { from_stage: 'Discovery',     to_stage: 'Qualification', entered: 48, advanced: 36, rate: 75.0 },
  { from_stage: 'Qualification', to_stage: 'Proposal',      entered: 36, advanced: 22, rate: 61.1 },
  { from_stage: 'Proposal',      to_stage: 'Negotiation',   entered: 22, advanced: 14, rate: 63.6 },
  { from_stage: 'Negotiation',   to_stage: 'Closed Won',    entered: 14, advanced: 9,  rate: 64.3 },
];

const DEMO_LEAD_AGING = [
  { bucket: '0–7d',   count: 14 },
  { bucket: '8–30d',  count: 22 },
  { bucket: '31–60d', count: 9 },
  { bucket: '60+d',   count: 5 },
];

const DEMO_COHORT_CONVERSION = (() => {
  const now = new Date();
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    const total = 28 + i * 4;
    const cells = Array.from({ length: 7 }, (_, age) => {
      const cumPct = Math.min(45, age * (6 + i));
      return { age_months: age, converted: Math.round(total * (cumPct / 100)), rate: cumPct };
    });
    return { cohort_month: d.toISOString().slice(0, 7), total, cells };
  });
})();

const DEMO_ENGAGEMENT_COMPARISON = {
  won:  { avg: 7.2, count: 18 },
  lost: { avg: 3.1, count: 24 },
};

const DEMO_DAYS_SINCE_TOUCH = [
  { bucket: '0d',     count: 8 },
  { bucket: '1–3d',   count: 16 },
  { bucket: '4–7d',   count: 11 },
  { bucket: '8–14d',  count: 7 },
  { bucket: '15–30d', count: 4 },
  { bucket: '30+d',   count: 3 },
];

const DEMO_SCORE_BAND_CONVERSION = [
  { band: '0–19',   total: 14, converted: 1,  rate: 7.1 },
  { band: '20–39',  total: 22, converted: 3,  rate: 13.6 },
  { band: '40–59',  total: 31, converted: 8,  rate: 25.8 },
  { band: '60–79',  total: 28, converted: 14, rate: 50.0 },
  { band: '80–100', total: 18, converted: 12, rate: 66.7 },
];

const DEMO_TERRITORY_CONVERSION = [
  { territory: 'Maharashtra', total: 42, converted: 14, rate: 33.3 },
  { territory: 'Karnataka',   total: 31, converted: 11, rate: 35.5 },
  { territory: 'Tamil Nadu',  total: 24, converted: 7,  rate: 29.2 },
  { territory: 'Delhi',       total: 18, converted: 6,  rate: 33.3 },
  { territory: 'Gujarat',     total: 16, converted: 5,  rate: 31.3 },
  { territory: 'Telangana',   total: 12, converted: 4,  rate: 33.3 },
  { territory: 'West Bengal', total: 9,  converted: 2,  rate: 22.2 },
];

const DEMO_TOUCHPOINTS_TO_RESPONSE = [
  { bucket: '1',  count: 12 },
  { bucket: '2',  count: 18 },
  { bucket: '3',  count: 14 },
  { bucket: '4',  count: 9 },
  { bucket: '5+', count: 11 },
  { bucket: 'No response', count: 24 },
];

const DEMO_LEADS_AT_RISK = [
  { lead_id: 'demo-lead-1',  name: 'Vikram Reddy (Skyline Developers)',  score: 88, owner_id: 'demo-user-id', days_idle: 16 },
  { lead_id: 'demo-lead-4',  name: 'Neha Gupta (Vega Infra)',            score: 92, owner_id: 'demo-user-id', days_idle: 21 },
  { lead_id: 'demo-lead-7',  name: 'Manish Khanna (Konkan Steel)',       score: 81, owner_id: 'demo-user-id', days_idle: 18 },
  { lead_id: 'demo-lead-10', name: 'Karan Verma (Suryadev Cement)',      score: 84, owner_id: 'demo-user-id', days_idle: 14 },
  { lead_id: 'demo-lead-11', name: 'Aditya Nair (Helios Constructions)', score: 78, owner_id: 'demo-user-id', days_idle: 22 },
];

// ── Dashboard layouts (per-user widget grid persistence) ────────────────

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

// CRM settings — realistic so the new B2B/B2C-aware settings page,
// field overrides, and notification preferences render with content
// instead of empty inputs.
const DEMO_CRM_SETTINGS = {
  business_type: 'both' as const,
  default_currency: 'INR',
  default_pipeline_id: 'demo-pipe',
  config: {
    field_overrides: {
      lead: {
        company:  { label: 'Company / Customer Name', required: true,  visible: true },
        industry: { label: 'Industry',                 required: false, visible: true },
        city:     { label: 'City',                     required: true,  visible: true },
        state:    { label: 'State',                    required: false, visible: true },
      },
      deal: {
        amount: { label: 'Order Value',          required: true, visible: true },
        name:   { label: 'Deal / Order Name',    required: true, visible: true },
      },
    },
    lead_scoring: {
      enabled: true,
      version: 2,
      grading: { A: 80, B: 60, C: 40, D: 0 },
      engagement_signals: { email_open: 5, email_click: 10, form_submit: 15, meeting_attended: 20 },
    },
    notifications: {
      email_enabled:    true,
      whatsapp_enabled: true,
      sms_enabled:      false,
    },
  },
};

// Sample integrations so the integrations wizard surface has visible
// entries on the demo account (the real /api/v1/integrations endpoint
// has its own demo middleware below).
const DEMO_INTEGRATIONS = [
  { id: 'demo-int-1', provider: 'web_form', name: 'Website Lead Form', is_active: true,  events_count: 14, last_event_at: new Date(Date.now() - 2*3600*1000).toISOString(),  created_at: new Date(Date.now() - 30*86400000).toISOString() },
  { id: 'demo-int-2', provider: 'zoho',     name: 'Zoho CRM Sync',     is_active: true,  events_count: 86, last_event_at: new Date(Date.now() - 1*3600*1000).toISOString(),  created_at: new Date(Date.now() - 45*86400000).toISOString() },
  { id: 'demo-int-3', provider: 'meta',     name: 'Meta Lead Ads',     is_active: true,  events_count: 42, last_event_at: new Date(Date.now() - 6*3600*1000).toISOString(),  created_at: new Date(Date.now() - 20*86400000).toISOString() },
  { id: 'demo-int-4', provider: 'google_ads',name:'Google Lead Form',  is_active: false, events_count: 0,  last_event_at: null,                                              created_at: new Date(Date.now() - 5*86400000).toISOString() },
];

// Lead/deal custom fields so the columns picker + form has options.
const DEMO_CUSTOM_FIELDS = [
  { id: 'demo-cf-1', entity: 'lead', key: 'preferred_grade', label: 'Preferred Steel Grade', type: 'select',  options: ['Fe-415','Fe-500','Fe-550','Fe-600'], required: false, visible: true, position: 0 },
  { id: 'demo-cf-2', entity: 'lead', key: 'monthly_volume',  label: 'Monthly Volume (MT)',   type: 'number',  options: [],                                  required: false, visible: true, position: 1 },
  { id: 'demo-cf-3', entity: 'lead', key: 'gst_number',      label: 'GST Number',            type: 'text',    options: [],                                  required: false, visible: true, position: 2 },
  { id: 'demo-cf-4', entity: 'deal', key: 'delivery_terms',  label: 'Delivery Terms',        type: 'select',  options: ['Ex-Works','FOR Site','CIF'],       required: false, visible: true, position: 0 },
  { id: 'demo-cf-5', entity: 'deal', key: 'payment_terms',   label: 'Payment Terms',         type: 'select',  options: ['Advance','15 days','30 days','45 days'], required: false, visible: true, position: 1 },
];

// One sample automation + assignment rule so the empty-state cards on
// those tabs no longer hide the fact that the feature ships.
const DEMO_AUTOMATIONS = [
  { id: 'demo-auto-1', name: 'Auto-assign hot leads to top rep', trigger: 'lead.created', conditions: { score_gte: 75 }, actions: [{ type: 'assign_to_user', user_id: 'demo-user-id' }], is_active: true, created_at: new Date(Date.now() - 20*86400000).toISOString() },
];
const DEMO_ASSIGNMENT_RULES = [
  { id: 'demo-rule-1', name: 'Round-robin by territory', strategy: 'round_robin', territory_id: 'demo-terr-1', user_ids: ['demo-user-id'], is_active: true, created_at: new Date(Date.now() - 60*86400000).toISOString() },
];

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

// --------------------------------------------------------------------

const json = (res: Response, body: unknown) => res.json(body);
const list = <T,>(rows: T[]) => ({ data: rows, total: rows.length, limit: rows.length, offset: 0 });
const ok = <T,>(body: T) => body;

// The generic dataset, assembled from the module-level consts. Kept at module
// scope (not inline in the middleware) so the in-function destructure that
// shadows these names doesn't shadow this object's initializer too.
const GENERIC_CRM = {
  LEADS, ACCOUNTS, CONTACTS, STAGES, PIPELINES, DEALS, ACTIVITIES, SOURCES,
  DEMO_DASHBOARD_SUMMARY, DEMO_PIPELINE_VALUE, DEMO_FUNNEL, DEMO_WIN_RATE_BY_REP,
  DEMO_FORECAST, DEMO_HEATMAP, DEMO_LEAD_SOURCE_ROI, DEMO_SCORE_DIST, DEMO_SALES_CYCLE,
  DEMO_DASHBOARD_COMPLETE, DEMO_TERRITORIES, DEMO_PRODUCTS, DEMO_CRM_SETTINGS,
  DEMO_CUSTOM_FIELDS, DEMO_AUTOMATIONS, DEMO_ASSIGNMENT_RULES,
  DEMO_ANALYTICS_LAYOUT, DEMO_OVERVIEW_LAYOUT,
  DEMO_LEAD_VELOCITY, DEMO_TIME_TO_FIRST_TOUCH, DEMO_STUCK_LEADS_KPI, DEMO_LOST_REASONS,
  DEMO_WON_REASONS, DEMO_DISQUAL_REASONS, DEMO_STAGE_CONVERSION, DEMO_LEAD_AGING,
  DEMO_COHORT_CONVERSION, DEMO_ENGAGEMENT_COMPARISON, DEMO_DAYS_SINCE_TOUCH,
  DEMO_SCORE_BAND_CONVERSION, DEMO_TERRITORY_CONVERSION, DEMO_TOUCHPOINTS_TO_RESPONSE,
  DEMO_LEADS_AT_RISK,
};

export function demoCrmMiddleware(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: { org_id?: string } }).user;
  if (!isDemo(user)) return next();

  // Resolve the active dataset for this request's demo industry, then shadow
  // the module-level consts so the handler body below transparently serves the
  // chosen vertical. Generic stays byte-identical (uses the module consts).
  const _industry = currentDemoIndustry();
  const D = _industry === 'insurance'      ? INSURANCE_CRM
          : _industry === 'pharmaceutical' ? PHARMACEUTICAL_CRM
          : GENERIC_CRM;
  const {
    LEADS, ACCOUNTS, CONTACTS, STAGES, PIPELINES, DEALS, ACTIVITIES, SOURCES,
    DEMO_DASHBOARD_SUMMARY, DEMO_PIPELINE_VALUE, DEMO_FUNNEL, DEMO_WIN_RATE_BY_REP,
    DEMO_FORECAST, DEMO_HEATMAP, DEMO_LEAD_SOURCE_ROI, DEMO_SCORE_DIST, DEMO_SALES_CYCLE,
    DEMO_DASHBOARD_COMPLETE, DEMO_TERRITORIES, DEMO_PRODUCTS, DEMO_CRM_SETTINGS,
    DEMO_CUSTOM_FIELDS, DEMO_AUTOMATIONS, DEMO_ASSIGNMENT_RULES,
    DEMO_ANALYTICS_LAYOUT, DEMO_OVERVIEW_LAYOUT,
    DEMO_LEAD_VELOCITY, DEMO_TIME_TO_FIRST_TOUCH, DEMO_STUCK_LEADS_KPI, DEMO_LOST_REASONS,
    DEMO_WON_REASONS, DEMO_DISQUAL_REASONS, DEMO_STAGE_CONVERSION, DEMO_LEAD_AGING,
    DEMO_COHORT_CONVERSION, DEMO_ENGAGEMENT_COMPARISON, DEMO_DAYS_SINCE_TOUCH,
    DEMO_SCORE_BAND_CONVERSION, DEMO_TERRITORY_CONVERSION, DEMO_TOUCHPOINTS_TO_RESPONSE,
    DEMO_LEADS_AT_RISK,
  } = D;
  // STAGES is consumed at module scope (DEMO_PIPELINE_VALUE); reference it here
  // so the shadowed binding isn't flagged as unused under noUnusedLocals.
  void STAGES;

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
    if (path === '/automations')    { json(res, list(DEMO_AUTOMATIONS));        return; }
    if (path === '/assignment-rules'){ json(res, list(DEMO_ASSIGNMENT_RULES));  return; }
    if (path === '/custom-fields')  { json(res, list(DEMO_CUSTOM_FIELDS));      return; }
    if (path === '/settings')       { json(res, ok(DEMO_CRM_SETTINGS));         return; }

    // KINI quota/credits + tools manifest — keep the chat surface usable
    // without burning real Anthropic credits on the shared demo tenant.
    if (path === '/ai/credits')     { json(res, ok({ balance: 9999, plan: 'demo', renews_at: null })); return; }
    if (path === '/ai/usage')       { json(res, ok({ used_today: 0, daily_limit: 9999, queries_this_month: 0 })); return; }
    if (path === '/ai/tools')       { json(res, ok([])); return; }

    // Stuck leads list (the lead-management listing — distinct from
    // the /analytics/stuck-leads KPI tile below).
    if (path === '/leads/stuck') {
      const stuck = LEADS.filter(l => ['new','working','nurturing','qualified'].includes(l.status)).slice(0, 8);
      json(res, list(stuck));
      return;
    }

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

    // Analytics (legacy stat-card + chart endpoints)
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

    // Extended analytics (15 widgets that power the customisable Lead
    // Analytics page + the Pinned strip on the CRM Overview).
    if (path === '/analytics/lead-velocity')            { json(res, DEMO_LEAD_VELOCITY);          return; }
    if (path === '/analytics/time-to-first-touch')      { json(res, DEMO_TIME_TO_FIRST_TOUCH);    return; }
    if (path === '/analytics/stuck-leads')              { json(res, DEMO_STUCK_LEADS_KPI);        return; }
    if (path === '/analytics/lost-reasons')             { json(res, DEMO_LOST_REASONS);           return; }
    if (path === '/analytics/won-reasons')              { json(res, DEMO_WON_REASONS);            return; }
    if (path === '/analytics/disqualification-reasons') { json(res, DEMO_DISQUAL_REASONS);        return; }
    if (path === '/analytics/stage-conversion')         { json(res, DEMO_STAGE_CONVERSION);       return; }
    if (path === '/analytics/lead-aging')               { json(res, DEMO_LEAD_AGING);             return; }
    if (path === '/analytics/cohort-conversion')        { json(res, DEMO_COHORT_CONVERSION);      return; }
    if (path === '/analytics/engagement-comparison')    { json(res, DEMO_ENGAGEMENT_COMPARISON);  return; }
    if (path === '/analytics/days-since-touch')         { json(res, DEMO_DAYS_SINCE_TOUCH);       return; }
    if (path === '/analytics/score-band-conversion')    { json(res, DEMO_SCORE_BAND_CONVERSION);  return; }
    if (path === '/analytics/territory-conversion')     { json(res, DEMO_TERRITORY_CONVERSION);   return; }
    if (path === '/analytics/touchpoints-to-response')  { json(res, DEMO_TOUCHPOINTS_TO_RESPONSE);return; }
    if (path === '/analytics/leads-at-risk')            { json(res, DEMO_LEADS_AT_RISK);          return; }

    // Per-user dashboard layouts (the widget grid + pinned-on-overview).
    if (path === '/dashboard-layouts/analytics')        { json(res, DEMO_ANALYTICS_LAYOUT); return; }
    if (path === '/dashboard-layouts/overview')         { json(res, DEMO_OVERVIEW_LAYOUT);  return; }
  }

  // Mutations on the dashboard-layouts endpoints must return a layout-shaped
  // body — the FE crashes if it tries to read .widgets / .layouts from the
  // generic {id, ok, demo} fallback below.
  if (method === 'PUT' && path === '/dashboard-layouts/analytics') {
    json(res, (req.body && typeof req.body === 'object') ? req.body : DEMO_ANALYTICS_LAYOUT);
    return;
  }
  if (method === 'PUT' && path === '/dashboard-layouts/overview') {
    json(res, (req.body && typeof req.body === 'object') ? req.body : DEMO_OVERVIEW_LAYOUT);
    return;
  }
  if (method === 'POST' && path === '/dashboard-layouts/overview/pin') {
    const widget = req.body as { id?: string; widget_type?: string; chart_type?: string } | undefined;
    if (widget?.id && widget?.widget_type) {
      const next = {
        widgets: [...DEMO_OVERVIEW_LAYOUT.widgets, widget],
        layouts: {
          lg: [...DEMO_OVERVIEW_LAYOUT.layouts.lg, { i: widget.id, x: 0, y: 8,  w: 6, h: 4 }],
          md: [...DEMO_OVERVIEW_LAYOUT.layouts.md, { i: widget.id, x: 0, y: 8,  w: 4, h: 4 }],
          sm: [...DEMO_OVERVIEW_LAYOUT.layouts.sm, { i: widget.id, x: 0, y: 16, w: 2, h: 4 }],
        },
      };
      json(res, next); return;
    }
    json(res, DEMO_OVERVIEW_LAYOUT); return;
  }
  if (method === 'DELETE') {
    const layoutDelM = path.match(/^\/dashboard-layouts\/(analytics|overview)\/widgets\/([^/]+)$/);
    if (layoutDelM) {
      const page = layoutDelM[1];
      const wid  = layoutDelM[2];
      const src = page === 'overview' ? DEMO_OVERVIEW_LAYOUT : DEMO_ANALYTICS_LAYOUT;
      json(res, {
        widgets: src.widgets.filter(w => w.id !== wid),
        layouts: {
          lg: src.layouts.lg.filter(it => it.i !== wid),
          md: src.layouts.md.filter(it => it.i !== wid),
          sm: src.layouts.sm.filter(it => it.i !== wid),
        },
      });
      return;
    }
  }

  // KINI agentic chat — return a friendly canned response so the demo
  // can show off the chat UI without hitting Anthropic. The shape mirrors
  // the legacy /crm/ai/chat handler: { reply, cards?, thread_id }.
  if (method === 'POST' && (path === '/ai/chat' || path === '/ai/chat/')) {
    const body = (req.body as { message?: string; thread_id?: string } | undefined) ?? {};
    const q = (body.message || '').toLowerCase();
    let reply = "Hi! I'm KINI, your CRM copilot. In demo mode I'll show you canned answers — try asking 'show me hot leads' or 'forecast for this quarter'.";
    type Card = { type: string; title: string; rows?: Array<Record<string, unknown>>; value?: string; subtitle?: string };
    let cards: Card[] = [];
    if (q.includes('hot') || q.includes('lead')) {
      reply = "Here are your top 3 leads by score. Vikram Reddy at Skyline Developers is your hottest — score 88, qualified, last touched yesterday.";
      cards = [{
        type: 'lead_list',
        title: 'Top leads',
        rows: LEADS.slice(0, 3).map(l => ({ id: l.id, name: `${l.first_name} ${l.last_name}`, company: l.company, score: l.score, status: l.status })),
      }];
    } else if (q.includes('forecast') || q.includes('pipeline') || q.includes('revenue')) {
      reply = "Your committed forecast this quarter is ₹2.4Cr against a ₹6.1Cr pipeline. Two deals close this week: Suryadev OPC Cement (₹98L) and Zenith Pune Hi-Rise (₹1.24Cr).";
      cards = [{ type: 'forecast', title: 'Quarter forecast', value: '₹2.4Cr committed', subtitle: 'of ₹6.1Cr pipeline' }];
    } else if (q.includes('stuck') || q.includes('risk')) {
      reply = "3 deals are stuck >14 days without activity. Trident Substation has had no touch for 18 days — worth a call.";
      cards = [{
        type: 'deal_list',
        title: 'Stuck deals',
        rows: DEALS.filter(d => d.status === 'open').slice(0, 3).map(d => ({ id: d.id, name: d.name, amount: d.amount, stage: d.stage_name })),
      }];
    }
    json(res, { reply, cards, thread_id: body.thread_id || 'demo-thread-1', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 } });
    return;
  }

  // Mark lead as won / reopen — return a lead-shaped body so the FE can
  // update its local row without choking on a generic {id, ok, demo} stub.
  if (method === 'POST') {
    const wonM = path.match(/^\/leads\/([^/]+)\/won$/);
    if (wonM) {
      const lead = LEADS.find(l => l.id === wonM[1]) || LEADS[0];
      const body = (req.body as { reason?: string } | undefined) ?? {};
      json(res, { ...lead, status: 'converted', won_reason: body.reason ?? null, won_at: new Date().toISOString() });
      return;
    }
    const reopenM = path.match(/^\/leads\/([^/]+)\/reopen$/);
    if (reopenM) {
      const lead = LEADS.find(l => l.id === reopenM[1]) || LEADS[0];
      json(res, { ...lead, status: 'working', is_converted: false, converted_at: null });
      return;
    }
  }

  // Catch-all mutations: pretend-success no-op so the demo can click around
  // without 500s.
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    if (method === 'DELETE') { res.status(204).end(); return; }
    res.status(method === 'POST' ? 201 : 200).json({ id: 'demo-noop-' + Math.random().toString(36).slice(2, 8), ok: true, demo: true });
    return;
  }

  return next();
}

/**
 * Demo middleware for /api/v1/integrations — separate from the CRM router
 * so the integrations wizard, Google Calendar status banner, and per-row
 * events surface canned content instead of an empty list.
 */
export function demoIntegrationsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: { org_id?: string } }).user;
  if (!isDemo(user)) return next();

  const path = req.path; // relative to /api/v1/integrations
  const method = req.method;

  if (method === 'GET') {
    if (path === '/' || path === '')                  { json(res, DEMO_INTEGRATIONS); return; }
    if (path === '/google/status')                    { json(res, { connected: false, configured: true }); return; }
    if (path === '/google/authorize')                 { json(res, { url: '#demo-google-oauth' }); return; }
    const idM = path.match(/^\/([^/]+)$/);
    if (idM) {
      const row = DEMO_INTEGRATIONS.find(i => i.id === idM[1]) || DEMO_INTEGRATIONS[0];
      json(res, row); return;
    }
    const eventsM = path.match(/^\/([^/]+)\/events$/);
    if (eventsM) { json(res, list([])); return; }
  }

  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    if (method === 'DELETE') { res.status(204).end(); return; }
    res.status(method === 'POST' ? 201 : 200).json({ id: 'demo-int-noop-' + Math.random().toString(36).slice(2, 8), ok: true, demo: true });
    return;
  }

  return next();
}
