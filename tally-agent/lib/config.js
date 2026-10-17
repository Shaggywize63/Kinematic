'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_SERVER = 'https://api.kinematicapp.com';
const isPackaged = () => !!process.pkg;

/** Where config.json + the log live. Windows: %ProgramData%\Kinematic\TallyConnector; else next to the script (legacy / dev). */
function dataDir() {
  if (process.env.KINEMATIC_TALLY_HOME) return path.resolve(process.env.KINEMATIC_TALLY_HOME);
  if (process.platform === 'win32') return path.join(process.env.ProgramData || 'C:\\ProgramData', 'Kinematic', 'TallyConnector');
  return path.resolve(__dirname, '..');
}
function configPath() {
  if (process.env.KINEMATIC_TALLY_CONFIG) return path.resolve(process.env.KINEMATIC_TALLY_CONFIG);
  const primary = path.join(dataDir(), 'config.json');
  if (fs.existsSync(primary)) return primary;
  // v0.1 installs kept config.json next to index.js.
  const legacy = path.resolve(__dirname, '..', 'config.json');
  return fs.existsSync(legacy) ? legacy : primary;
}
const REQUIRED = ['polling_endpoint', 'report_endpoint', 'integration_id'];
function normalise(cfg) {
  return {
    integration_id: cfg.integration_id, agent_secret: cfg.agent_secret,
    polling_endpoint: cfg.polling_endpoint, report_endpoint: cfg.report_endpoint,
    tally_url: cfg.tally_url || 'http://localhost:9000', poll_interval_seconds: cfg.poll_interval_seconds || 30,
    company_name: cfg.company_name || null,
  };
}
/** config.json holds one connection per Kinematic company: {connections:[...]}. A v0.3 file is a single bare connection. */
function readRaw(p) {
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return Array.isArray(raw.connections) ? raw.connections : [raw];
}
/** Every connection on this PC (one per Tally company / Kinematic company pairing). */
function loadAll() {
  const p = configPath();
  if (!fs.existsSync(p)) return { error: `Not paired yet (no config at ${p}). Run: kinematic-tally-agent pair <CODE>` };
  let list;
  try { list = readRaw(p); } catch (e) { return { error: `Config at ${p} is not valid JSON: ${e.message}` }; }
  if (list.length === 0 || list.some(c => REQUIRED.some(k => !c[k]))) return { error: `Config at ${p} is missing required fields. Pair again.` };
  return { path: p, connections: list.map(normalise) };
}
/** The first connection (what single-company callers use). */
function loadConfig() {
  const l = loadAll();
  return l.error ? l : { path: l.path, cfg: l.connections[0], connections: l.connections };
}
/** Add a connection, or replace the one for the same integration, keeping the others. */
function saveConfig(cfg) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'config.json');
  let list = [];
  try { if (fs.existsSync(p)) list = readRaw(p); } catch { list = []; }
  const i = list.findIndex(c => c.integration_id === cfg.integration_id);
  if (i >= 0) list[i] = cfg; else list.push(cfg);
  fs.writeFileSync(p, JSON.stringify({ connections: list }, null, 2), { mode: 0o600 });
  return p;
}
/** Sibling endpoint of the polling URL, keeping the ?key=. */
function endpoint(cfg, suffix) {
  const u = new URL(cfg.polling_endpoint);
  u.pathname = u.pathname.replace(/\/$/, '') + suffix;
  return u.toString();
}
function logTo(file) {
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    if (!file) return;
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.1');
      fs.appendFileSync(file, line + os.EOL);
    } catch { /* logging must never crash the agent */ }
  };
}
module.exports = { DEFAULT_SERVER, isPackaged, dataDir, configPath, loadConfig, loadAll, saveConfig, endpoint, logTo };
