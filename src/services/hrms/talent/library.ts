// The standard Talent library and the "populated demo" seed. Pure functions, no database access.
//
// The 12-skill catalogue matches the dashboard's seed (lib/hrms/people/seedTalent.ts SKILLS) by stable key, so a skill is
// referenced by the same id ("sk_field") on both sides. Everything else (requirements per designation, ratings, critical
// roles with a succession bench, 9-box placements) is GENERATED deterministically against the org's REAL employees,
// designations, departments and locations — the live org does not carry the sample's synthetic ids, so the picture is
// adapted to whatever rows exist. With no employees it degrades to just the skills catalogue.

export interface StandardSkill { key: string; name: string; group: string; blurb: string }

export const STANDARD_SKILLS: StandardSkill[] = [
  { key: 'sk_field', name: 'Field selling', group: 'Sales', blurb: 'Plans a beat, runs a visit, closes and records it.' },
  { key: 'sk_negot', name: 'Negotiation', group: 'Sales', blurb: 'Agrees price and terms without giving away more than needed.' },
  { key: 'sk_excel', name: 'Excel and reporting', group: 'Finance', blurb: 'Builds tables, lookups, pivots and checks its own totals.' },
  { key: 'sk_close', name: 'Month-end close', group: 'Finance', blurb: 'Reconciles accounts and closes the month on time.' },
  { key: 'sk_wh', name: 'Warehouse operations', group: 'Operations', blurb: 'Runs inbound, storage and outbound flows.' },
  { key: 'sk_inv', name: 'Inventory control', group: 'Operations', blurb: 'Keeps stock records and physical stock in agreement.' },
  { key: 'sk_safety', name: 'Safety practice', group: 'Operations', blurb: 'Follows and promotes safe working on the floor.' },
  { key: 'sk_coach', name: 'Coaching and feedback', group: 'People', blurb: 'Holds useful one-to-ones and gives specific feedback.' },
  { key: 'sk_comm', name: 'Stakeholder communication', group: 'Core', blurb: 'Keeps clients and colleagues clearly informed.' },
  { key: 'sk_data', name: 'Data analysis', group: 'Technology', blurb: 'Turns data into a clear answer.' },
  { key: 'sk_design', name: 'Software design', group: 'Technology', blurb: 'Designs services that others can build on.' },
  { key: 'sk_plan', name: 'Project planning', group: 'Core', blurb: 'Breaks work into steps and delivers on the date agreed.' },
];

const SKILL_KEYS = STANDARD_SKILLS.map((s) => s.key);
const GROUP_OF: Record<string, string> = Object.fromEntries(STANDARD_SKILLS.map((s) => [s.key, s.group]));
const CORE_KEYS = SKILL_KEYS.filter((k) => GROUP_OF[k] === 'Core');            // sk_comm, sk_plan
const NONCORE_KEYS = SKILL_KEYS.filter((k) => GROUP_OF[k] !== 'Core');

const EVIDENCE: Record<string, string> = {
  sk_field: 'Ride-along on three beats: plans the day by outlet value and records every visit with a photo.',
  sk_negot: 'Held the agreed price on two distributor renewals without a discount.',
  sk_excel: 'Built the monthly reconciliation workbook the team now uses.',
  sk_close: 'Month-end close finished on time in each of the last two quarters.',
  sk_wh: 'Runs the inbound shift without supervision and plans dock slots.',
  sk_inv: 'Cycle counts within 0.5% of system stock for three months running.',
  sk_safety: 'Leads the shift safety huddle. No unreported near misses in the last audit.',
  sk_coach: 'Holds regular one-to-ones. Two people from the team were promoted in the last year.',
  sk_comm: 'Writes clear client updates and handled a delivery escalation calmly.',
  sk_data: 'Built a weekly report that the sales team now uses.',
  sk_design: 'Designed the visit-sync service and walked the team through it.',
  sk_plan: 'Planned and shipped the last release on the agreed date.',
};
const BASIC_NOTE = 'Assessed in the 2026 skills review. Works with guidance on this.';
const ASSESSOR_POOL = ['Arvind Nair', 'Vikram Joshi', 'Manoj Patil', 'Neha Bansal', 'Ritu Malhotra', 'Divya Menon'];
const PANEL = 'Talent review panel';
const READINESS_CYCLE = ['now', '1-2y', '3y+'] as const;
const SUCCESSOR_ACTIONS = [
  'Shadow the role for a quarter', 'Lead a project end to end', 'Cover the role during the next leave',
  'Finish the people-management essentials', 'Present to the leadership team once',
];
const PLACEMENT_RATIONALE = [
  'Based on the latest review of delivery and growth potential.',
  'Steady delivery; a development conversation is planned.',
  'Strong recent results and takes on stretch work.',
  'Meets the role well; next step still to be explored.',
  'Dependable in role; growth interest to be discussed.',
];

/** Map a department NAME to a skill group by keyword (the live org has no synthetic dept ids). */
export function deptGroupFromName(name: string | null | undefined): string | null {
  const n = (name ?? '').toLowerCase();
  if (/sale|business development|bd\b/.test(n)) return 'Sales';
  if (/financ|account|audit/.test(n)) return 'Finance';
  if (/warehouse|logistic|supply|operation|ops|dispatch/.test(n)) return 'Operations';
  if (/\bhr\b|human|people|talent|admin/.test(n)) return 'People';
  if (/tech|engineer|develop|software|data|it\b|product/.test(n)) return 'Technology';
  return null;
}

/** A small deterministic PRNG from a string seed, so the whole seed is stable across runs. */
export function rng(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (n: number): number => Math.max(0, Math.min(4, Math.round(n)));
const d2 = (n: number) => String(n).padStart(2, '0');
const pick = <T>(list: T[], r: number): T => list[Math.floor(r * list.length) % list.length]!;
const isLearner = (status: string): boolean => status === 'active' || status === 'on_notice';

export interface SeedEmployee {
  id: string;
  designation_id: string | null;
  department_id: string | null;
  location_id: string | null;
  join_date: string | null;
  status: string;
  reporting_to_id: string | null;
}
export interface SeedInput {
  employees: SeedEmployee[];
  designationIds: string[];
  deptNameById: Record<string, string>;
  designationNameById: Record<string, string>;
}

export interface SeedSuccessor { employee_id: string; readiness: string; actions: string[]; added_on: string }
export interface SeedChange { on_date: string; by_name: string; kind: string; employee_id: string | null; from_text: string | null; to_text: string | null; reason: string }
export interface SeedRole {
  title: string; department_id: string | null; location_id: string | null; incumbent_id: string;
  role_since: string | null; retirement_age: number; why: string;
  successors: SeedSuccessor[]; changes: SeedChange[];
}
export interface SeedData {
  skills: { key: string; name: string; skill_group: string; blurb: string; sort: number }[];
  requirements: { designation_id: string; skill_key: string; required_level: number }[];
  ratings: { employee_id: string; skill_key: string; level: number; note: string; by_name: string; on_date: string }[];
  roles: SeedRole[];
  placements: { employee_id: string; performance: number; potential: number; rationale: string; by_name: string; on_date: string }[];
  cycle: string;
}

/** The required level for each skill, by designation: the two Core skills at 2, plus two hashed non-core picks (3 and 2). */
function requirementsFor(designationIds: string[]): SeedData['requirements'] {
  const out: SeedData['requirements'] = [];
  for (const d of [...designationIds].sort()) {
    for (const k of CORE_KEYS) out.push({ designation_id: d, skill_key: k, required_level: 2 });
    const r = rng(`req:${d}`);
    const a = pick(NONCORE_KEYS, r());
    let b = pick(NONCORE_KEYS, r());
    if (b === a) b = NONCORE_KEYS[(NONCORE_KEYS.indexOf(a) + 1) % NONCORE_KEYS.length]!;
    out.push({ designation_id: d, skill_key: a, required_level: 3 });
    out.push({ designation_id: d, skill_key: b, required_level: 2 });
  }
  return out;
}

/** Ratings for every learner over all 12 skills, the dashboard's seedTalent formula, deterministically. 0 → no row. */
function ratingsFor(input: SeedInput, reqByDesig: Map<string, Map<string, number>>, today: string): SeedData['ratings'] {
  const out: SeedData['ratings'] = [];
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  for (const e of input.employees.filter((x) => isLearner(x.status))) {
    const need = (e.designation_id && reqByDesig.get(e.designation_id)) || new Map<string, number>();
    const group = deptGroupFromName(e.department_id ? input.deptNameById[e.department_id] : undefined);
    const years = e.join_date ? (todayMs - Date.parse(`${e.join_date}T00:00:00Z`)) / (365.25 * 86400000) : 0;
    const r = rng(`rat:${e.id}`);
    for (const key of SKILL_KEYS) {
      let level: number;
      const req = need.get(key);
      if (req != null) {
        const delta = [-2, -1, -1, 0, 0, 0, 1, 1][Math.floor(r() * 8)]!;
        level = req + delta + (years > 4 && delta >= 0 ? 0.6 : 0);
      } else if (GROUP_OF[key] === group) level = 1 + r() * 2;
      else if (GROUP_OF[key] === 'Core') level = 1 + r() * 1.5;
      else level = r() < 0.55 ? 0 : 1;
      const lvl = clamp(level);
      if (lvl === 0) continue;
      const month = 5 + Math.floor(r() * 6);
      const day = 3 + Math.floor(r() * 24);
      out.push({
        employee_id: e.id, skill_key: key, level: lvl,
        note: lvl >= 3 ? (EVIDENCE[key] ?? BASIC_NOTE) : BASIC_NOTE,
        by_name: pick(ASSESSOR_POOL, rng(`asr:${e.department_id ?? e.id}`)()),
        on_date: `2026-${d2(month)}-${d2(day)}`,
      });
    }
  }
  return out;
}

/** Up to six critical roles: the managers (anyone others report to) first, then the longest-tenured, each with a bench. */
function rolesFor(input: SeedInput): SeedData['roles'] {
  const active = input.employees.filter((e) => e.status === 'active' || e.status === 'on_notice');
  const byTenure = [...active].sort((a, b) => String(a.join_date ?? '9999').localeCompare(String(b.join_date ?? '9999')) || a.id.localeCompare(b.id));
  const managerIds = new Set(active.map((e) => e.reporting_to_id).filter((x): x is string => !!x));
  const incumbents: SeedEmployee[] = [];
  for (const e of byTenure) if (managerIds.has(e.id)) incumbents.push(e);
  for (const e of byTenure) if (incumbents.length >= 6) break; else if (!incumbents.includes(e)) incumbents.push(e);
  const roles: SeedData['roles'] = [];
  const takenSuccessors = new Set<string>();
  for (const inc of incumbents.slice(0, 6)) {
    const desig = inc.designation_id ? input.designationNameById[inc.designation_id] : undefined;
    const title = desig ? `${desig} (critical role)` : 'Critical role';
    const bench = byTenure.filter((e) => e.id !== inc.id && !takenSuccessors.has(e.id)).slice(0, 2);
    const addedOn = '2026-05-10';
    const successors: SeedSuccessor[] = [];
    const changes: SeedChange[] = [];
    bench.forEach((cand, i) => {
      takenSuccessors.add(cand.id);
      const readiness = READINESS_CYCLE[i % READINESS_CYCLE.length]!;
      const actions = [pick(SUCCESSOR_ACTIONS, rng(`act:${inc.id}:${cand.id}`)())];
      successors.push({ employee_id: cand.id, readiness, actions, added_on: addedOn });
      changes.push({ on_date: addedOn, by_name: PANEL, kind: 'added', employee_id: cand.id, from_text: null, to_text: readiness, reason: 'Named at the talent review.' });
    });
    roles.push({
      title, department_id: inc.department_id, location_id: inc.location_id, incumbent_id: inc.id,
      role_since: inc.join_date, retirement_age: 60,
      why: `Owns delivery for the ${desig ?? 'team'} and would be hard to replace at short notice.`,
      successors, changes,
    });
  }
  return roles;
}

/** A 9-box placement for up to eighteen active people, deterministic. */
function placementsFor(input: SeedInput, today: string): SeedData['placements'] {
  const active = input.employees.filter((e) => e.status === 'active' || e.status === 'on_notice').sort((a, b) => a.id.localeCompare(b.id));
  return active.slice(0, 18).map((e) => {
    const r = rng(`plc:${e.id}`);
    const performance = 1 + Math.floor(r() * 3);
    const potential = 1 + Math.floor(r() * 3);
    return { employee_id: e.id, performance, potential, rationale: pick(PLACEMENT_RATIONALE, r()), by_name: PANEL, on_date: '2026-10-20' };
  });
}

/** Build the whole populated-demo seed from the org's real rows. */
export function buildSeed(input: SeedInput, today: string): SeedData {
  const requirements = requirementsFor(input.designationIds);
  const reqByDesig = new Map<string, Map<string, number>>();
  for (const r of requirements) {
    if (!reqByDesig.has(r.designation_id)) reqByDesig.set(r.designation_id, new Map());
    reqByDesig.get(r.designation_id)!.set(r.skill_key, r.required_level);
  }
  return {
    skills: STANDARD_SKILLS.map((s, i) => ({ key: s.key, name: s.name, skill_group: s.group, blurb: s.blurb, sort: i })),
    requirements,
    ratings: ratingsFor(input, reqByDesig, today),
    roles: rolesFor(input),
    placements: placementsFor(input, today),
    cycle: 'FY 2026-27, first half',
  };
}
