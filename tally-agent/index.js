#!/usr/bin/env node
/**
 * Kinematic Tally Connector
 *
 *   kinematic-tally-agent pair <CODE> [--server URL] [--no-install]
 *        Exchange the 6-character code from the dashboard for this PC's config, register
 *        auto-start (Windows), and report to the dashboard.
 *   kinematic-tally-agent run [--once]     Poll Kinematic (default when no command is given).
 *   kinematic-tally-agent check            Print what the connector sees in Tally.
 *   kinematic-tally-agent install | uninstall   Windows auto-start task.
 *
 * Requires Node 18+ when run from source (the .exe bundles its own runtime). No npm dependencies.
 */
'use strict';
const path = require('node:path');
const C = require('./lib/config');
const A = require('./lib/agent');
const I = require('./lib/install');

const args = process.argv.slice(2);
const cmd = ['pair', 'run', 'check', 'install', 'uninstall'].includes(args[0]) ? args[0] : 'run';
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const log = C.logTo(path.join(C.dataDir(), 'agent.log'));

async function pair() {
  const code = args[1];
  if (!code || code.startsWith('--')) { console.error('Usage: kinematic-tally-agent pair <CODE>   (the 6-character code shown in the dashboard)'); return 1; }
  const server = (flag('--server') || process.env.KINEMATIC_SERVER || C.DEFAULT_SERVER).replace(/\/$/, '');
  let res, json;
  try {
    res = await fetch(`${server}/api/v1/integrations/tally/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    json = await res.json().catch(() => ({}));
  } catch (e) { console.error(`Could not reach ${server}: ${e.message}`); return 1; }
  if (!res.ok || !json.ok) { console.error(json.error || `Pairing failed (HTTP ${res.status})`); return 1; }
  const cfg = { ...json.config, company_name: json.company_name || null };
  const p = C.saveConfig(cfg);
  log(`Paired. Config saved to ${p}`);
  if (!args.includes('--no-install')) I.install(log);
  const ctx = A.newContext(cfg, log);
  const profile = await A.sendProfile(ctx, cfg.company_name).catch(e => ({ tally_reachable: false, tally_error: e.message }));
  if (profile.tally_reachable) log(`Tally is reachable. Companies: ${(profile.companies || []).join(', ') || '(none open)'}`);
  else log(`Tally is not reachable yet: ${profile.tally_error}\nThe dashboard will show what to fix.`);
  log('Done. Go back to the dashboard - the checklist updates automatically.');
  return 0;
}

async function check() {
  const l = C.loadConfig();
  const tallyUrl = l.cfg ? l.cfg.tally_url : 'http://localhost:9000';
  const profile = await A.collectProfile({ tally_url: tallyUrl }, l.cfg && l.cfg.company_name);
  console.log(JSON.stringify({ ...profile, ledgers: profile.ledgers ? `${profile.ledgers.length} ledgers` : undefined }, null, 2));
  return profile.tally_reachable ? 0 : 1;
}

async function run() {
  const l = C.loadConfig();
  if (l.error) { console.error(`[FATAL] ${l.error}`); return 1; }
  const ctx = A.newContext(l.cfg, log);
  log(`Kinematic Tally Connector ${A.VERSION}  integration=${l.cfg.integration_id}  tally=${l.cfg.tally_url}  every ${l.cfg.poll_interval_seconds}s`);
  if (args.includes('--once')) { await A.cycle(ctx); return 0; }
  let busy = false;
  const tick = async () => { if (busy) return; busy = true; try { await A.cycle(ctx); } catch (e) { log(`[ERROR] ${e.stack || e.message}`); } finally { busy = false; } };
  await tick();
  setInterval(tick, l.cfg.poll_interval_seconds * 1000);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log(`Received ${sig}, shutting down`); process.exit(0); });
  return new Promise(() => {}); // run forever
}

(async () => {
  const code = await ({ pair, run, check, install: async () => (I.install(log) ? 0 : 1), uninstall: async () => (I.uninstall(log), 0) })[cmd]();
  if (code !== undefined && cmd !== 'run') process.exit(code);
  if (cmd === 'run' && code) process.exit(code);
})().catch(e => { console.error(`[FATAL] ${e.stack || e.message || e}`); process.exit(1); });
