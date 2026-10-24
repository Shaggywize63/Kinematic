#!/usr/bin/env node
/**
 * Kinematic Tally Connector
 *
 *   (double-click)                Asks for the pairing code, pairs, installs auto-start, keeps the window open.
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
const S = require('./lib/setup');

const args = process.argv.slice(2);
const explicit = ['pair', 'run', 'check', 'install', 'uninstall'].includes(args[0]);
// No command + a real console (double-click, or run by hand) => guided setup. Without a console
// (scheduled task, pipe) keep the old behaviour of running the poller.
const cmd = explicit ? args[0] : (process.stdin.isTTY ? 'setup' : 'run');
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const log = C.logTo(path.join(C.dataDir(), 'agent.log'));

async function pair() {
  const code = args[1];
  if (!code || code.startsWith('--')) { console.error('Usage: kinematic-tally-agent pair <CODE>   (the 6-character code shown in the dashboard)'); return 1; }
  const server = flag('--server') || process.env.KINEMATIC_SERVER || C.DEFAULT_SERVER;
  const r = await S.pairAndInstall({ code, server, noInstall: args.includes('--no-install'), log });
  if (!r.ok) { console.error(r.error); return 1; }
  S.describeProfile(r.profile, log);
  log('Done. Go back to the dashboard - the checklist updates automatically.');
  return 0;
}

/** Double-click flow. Keeps the window open at the end so the person can read the result. */
async function setup() {
  // Registering the startup task needs administrator rights: ask Windows once, up front, and let the
  // elevated copy take over (this window then closes straight away).
  if (process.platform === 'win32' && C.isPackaged() && I.isAdmin() === false) {
    console.log('Windows needs your permission to set the connector up to start automatically...');
    if (I.relaunchElevated()) return 0;
    console.log('(Could not ask for permission automatically - continuing without it.)');
  }
  const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(res => rl.question(q, res));
  const say = (m) => console.log(m);
  try {
    const existing = C.loadAll().connections || null;
    await S.interactive({ ask, say, log, existingConfig: existing });
  } finally {
    await ask('\nPress Enter to close this window… ');   // keep the window readable after a double-click
    rl.close();
  }
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
  const l = C.loadAll();
  if (l.error) { console.error(`[FATAL] ${l.error}`); return 1; }
  // One connection per Kinematic company; each polls on its own and posts to the same local Tally.
  const ctxs = l.connections.map(cfg => {
    const prefix = l.connections.length > 1 ? `[${cfg.company_name || cfg.integration_id.slice(0, 8)}] ` : '';
    return A.newContext(cfg, (m) => log(prefix + m));
  });
  for (const ctx of ctxs) log(`Kinematic Tally Connector ${A.VERSION}  integration=${ctx.cfg.integration_id}  company=${ctx.cfg.company_name || '-'}  tally=${ctx.cfg.tally_url}  every ${ctx.cfg.poll_interval_seconds}s`);
  if (args.includes('--once')) { for (const ctx of ctxs) await A.cycle(ctx); return 0; }
  for (const ctx of ctxs) {
    let busy = false;
    const tick = async () => { if (busy) return; busy = true; try { await A.cycle(ctx); } catch (e) { ctx.log(`[ERROR] ${e.stack || e.message}`); } finally { busy = false; } };
    await tick();
    setInterval(tick, ctx.cfg.poll_interval_seconds * 1000);
  }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log(`Received ${sig}, shutting down`); process.exit(0); });
  return new Promise(() => {}); // run forever
}

(async () => {
  const code = await ({ setup, pair, run, check, install: async () => (I.install(log) ? 0 : 1), uninstall: async () => (I.uninstall(log), 0) })[cmd]();
  if (code !== undefined && cmd !== 'run') process.exit(code);
  if (cmd === 'run' && code) process.exit(code);
})().catch(e => { console.error(`[FATAL] ${e.stack || e.message || e}`); process.exit(1); });
