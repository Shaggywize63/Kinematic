'use strict';
const T = require('./tally');
const { endpoint } = require('./config');

const VERSION = require('../package.json').version;
const BATCH = 500;
const PROFILE_EVERY_MS = 10 * 60 * 1000;

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Kinematic returned HTTP ${res.status} for ${new URL(url).pathname}`);
  return res.json().catch(() => ({}));
}

/** Everything the dashboard's readiness checklist needs, gathered from the local Tally. */
async function collectProfile(cfg, wantedCompany) {
  const profile = { agent_version: VERSION };
  let companies;
  try { companies = await T.listCompanies(cfg.tally_url); }
  catch (e) { return { ...profile, tally_reachable: false, tally_error: e.message }; }
  profile.tally_reachable = true;
  profile.companies = companies;
  const company = wantedCompany && companies.some(c => c.toLowerCase() === wantedCompany.toLowerCase())
    ? companies.find(c => c.toLowerCase() === wantedCompany.toLowerCase()) : companies[0];
  profile.current_company = company || null;
  if (!company) return profile;
  try {
    const [ledgers, groups, vts] = await Promise.all([T.listLedgers(cfg.tally_url, company), T.listGroups(cfg.tally_url, company), T.listVoucherTypes(cfg.tally_url, company)]);
    profile.ledgers = ledgers.map(l => ({ name: l.name, parent: l.parent }));
    profile.voucher_types = vts;
    profile.party_count = T.partiesFrom(ledgers, groups).length;
  } catch (e) { profile.tally_error = e.message; }
  return profile;
}

async function sendProfile(ctx, wantedCompany) {
  const profile = await collectProfile(ctx.cfg, wantedCompany);
  await postJson(endpoint(ctx.cfg, '/profile'), profile);
  ctx.lastProfileAt = Date.now();
  return profile;
}

async function pullMasters(ctx, wantedCompany) {
  const { cfg, log } = ctx;
  const companies = await T.listCompanies(cfg.tally_url);
  const company = companies.find(c => c.toLowerCase() === String(wantedCompany || '').toLowerCase()) || companies[0];
  if (!company) throw new Error('No company is open in Tally');
  const [ledgers, groups] = await Promise.all([T.listLedgers(cfg.tally_url, company), T.listGroups(cfg.tally_url, company)]);
  const parties = T.partiesFrom(ledgers, groups);
  const items = await T.listStockItems(cfg.tally_url, company);
  log(`  pulled ${items.length} stock item(s) and ${parties.length} party ledger(s) from "${company}"`);
  const url = endpoint(cfg, '/masters');
  const send = async (kind, list, isLast) => {
    if (list.length === 0 && isLast) return postJson(url, { kind, items: [], final: true });
    for (let i = 0; i < list.length; i += BATCH) {
      await postJson(url, { kind, items: list.slice(i, i + BATCH), final: isLast && i + BATCH >= list.length });
    }
  };
  await send('stock_item', items, false);
  await send('party', parties, true);
}

/** Export the vouchers we pushed and report their Tally status back (two-way order-status sync). */
async function pullVouchers(ctx, wantedCompany) {
  const { cfg, log } = ctx;
  const companies = await T.listCompanies(cfg.tally_url);
  const company = companies.find(c => c.toLowerCase() === String(wantedCompany || '').toLowerCase()) || companies[0];
  if (!company) throw new Error('No company is open in Tally');
  const vouchers = await T.listVouchers(cfg.tally_url, company);
  log(`  pulled ${vouchers.length} Kinematic voucher(s) from "${company}"`);
  const url = endpoint(cfg, '/vouchers');
  if (vouchers.length === 0) { await postJson(url, { items: [], final: true }); return; }
  for (let i = 0; i < vouchers.length; i += BATCH) {
    await postJson(url, { items: vouchers.slice(i, i + BATCH), final: i + BATCH >= vouchers.length });
  }
}

async function handleCommand(ctx, cmd, serverCompany) {
  const { cfg, log } = ctx;
  let result;
  try {
    if (cmd.type === 'pull_masters') {
      await pullMasters(ctx, serverCompany);
      result = { ok: true };
    } else if (cmd.type === 'pull_vouchers') {
      await pullVouchers(ctx, serverCompany);
      result = { ok: true };
    } else if (cmd.type === 'tally_xml' && typeof cmd.xml === 'string') {
      const r = T.parseImportResponse(await T.tallyPost(cfg.tally_url, cmd.xml));
      result = r.ok ? { ok: true } : { ok: false, error: r.error };
    } else {
      result = { ok: false, error: `Unknown command ${cmd.type} (update the connector)` };
    }
  } catch (e) { result = { ok: false, error: e.message }; }
  log(`  command ${cmd.type}${cmd.label ? ':' + cmd.label : ''} -> ${result.ok ? 'ok' : 'FAILED: ' + result.error}`);
  try { await postJson(endpoint(cfg, '/command-result'), { command_id: cmd.id, ok: result.ok, error: result.error }); }
  catch (e) { log(`[WARN] could not report command result: ${e.message}`); }
  // Anything that may have changed Tally's masters: refresh the checklist now.
  if (cmd.type === 'tally_xml') { try { await sendProfile(ctx, serverCompany); } catch { /* next cycle */ } }
}

async function handleJob(ctx, job) {
  const start = Date.now();
  let result;
  const isMaster = String(job.kind || '').startsWith('master_');
  try { result = T.parseImportResponse(await T.tallyPost(ctx.cfg.tally_url, job.xml_payload), { tolerateExisting: isMaster }); }
  catch (e) { result = { ok: false, error: e.message }; }
  ctx.log(`  ${result.ok ? '✓' : '✗'} ${job.kind} ${job.ref_id} → ${result.ok ? 'Tally voucher ' + (result.tally_voucher_id || '(no id)') : result.error} (${Date.now() - start}ms)`);
  try {
    await postJson(ctx.cfg.report_endpoint, { event_id: job.event_id, ok: result.ok, tally_voucher_id: result.tally_voucher_id, error: result.error });
  } catch (e) { ctx.log(`[ERROR] reportResult failed for event ${job.event_id}: ${e.message}`); }
}

/** One poll: jobs, commands, and a periodic profile refresh. Returns how many things it did. */
async function cycle(ctx) {
  let json;
  try {
    const res = await fetch(ctx.cfg.polling_endpoint, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Kinematic poll returned HTTP ${res.status}`);
    json = await res.json();
    if (!json.ok) throw new Error(json.error || 'unknown');
  } catch (e) { ctx.log(`[ERROR] poll failed: ${e.message}`); return 0; }

  const serverCompany = json.company_name || ctx.cfg.company_name || null;
  let n = 0;
  if (!ctx.lastProfileAt || Date.now() - ctx.lastProfileAt > PROFILE_EVERY_MS) {
    try { await sendProfile(ctx, serverCompany); } catch (e) { ctx.log(`[WARN] profile not sent: ${e.message}`); }
  }
  for (const cmd of json.commands || []) {
    if (ctx.done.has(cmd.id)) continue;
    ctx.done.add(cmd.id); n++;
    await handleCommand(ctx, cmd, serverCompany);
  }
  const jobs = json.jobs || [];
  if (jobs.length) ctx.log(`processing ${jobs.length} job(s)`);
  for (const job of jobs) { await handleJob(ctx, job); n++; }
  return n;
}

const newContext = (cfg, log) => ({ cfg, log, done: new Set(), lastProfileAt: 0 });

module.exports = { VERSION, collectProfile, sendProfile, pullMasters, pullVouchers, cycle, newContext };
