'use strict';
// Windows auto-start via Task Scheduler (no service wrapper / no dependencies).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { dataDir, isPackaged } = require('./config');

const TASK = 'Kinematic Tally Connector';

function run(cmd, args) { return spawnSync(cmd, args, { encoding: 'utf-8', windowsHide: true }); }

function install(log) {
  if (process.platform !== 'win32') { log('Auto-start install is Windows-only; run "node index.js run" under your own supervisor.'); return false; }
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  let exe, args;
  if (isPackaged()) {
    exe = path.join(dir, 'kinematic-tally-agent.exe');
    if (path.resolve(process.execPath) !== path.resolve(exe)) fs.copyFileSync(process.execPath, exe);
    args = 'run';
  } else {
    exe = process.execPath;
    args = `"${path.resolve(__dirname, '..', 'index.js')}" run`;
  }
  const tr = `"${exe}" ${args}`;
  const create = run('schtasks', ['/Create', '/TN', TASK, '/TR', tr, '/SC', 'ONSTART', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F']);
  if (create.status !== 0) { log(`Could not register the startup task (run as Administrator?): ${(create.stderr || create.stdout || '').trim()}`); return false; }
  // The config holds the agent secret: restrict the folder to SYSTEM + Administrators.
  run('icacls', [dir, '/inheritance:r', '/grant:r', 'SYSTEM:(OI)(CI)F', 'Administrators:(OI)(CI)F']);
  run('schtasks', ['/Run', '/TN', TASK]);
  log(`Installed. "${TASK}" starts automatically with Windows and is running now.`);
  return true;
}
function uninstall(log) {
  if (process.platform !== 'win32') return false;
  run('schtasks', ['/End', '/TN', TASK]);
  const r = run('schtasks', ['/Delete', '/TN', TASK, '/F']);
  log(r.status === 0 ? 'Startup task removed.' : `Nothing to remove (${(r.stderr || '').trim()})`);
  return true;
}
module.exports = { install, uninstall, TASK };
