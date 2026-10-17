'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const conn = (id, name) => ({ integration_id: id, agent_secret: 's' + id, polling_endpoint: `http://x/jobs/${id}?key=s`, report_endpoint: `http://x/jobs/${id}/result?key=s`, company_name: name });
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktc-'));
  process.env.KINEMATIC_TALLY_HOME = dir;
  delete process.env.KINEMATIC_TALLY_CONFIG;
  delete require.cache[require.resolve('../lib/config')];
  return { dir, C: require('../lib/config') };
}

test('pairing a second company adds a connection and keeps the first', () => {
  const { C } = fresh();
  C.saveConfig(conn('a', 'Gomant Traders LLP'));
  C.saveConfig(conn('b', 'Royal Spirits North'));
  const l = C.loadAll();
  assert.deepStrictEqual(l.connections.map(c => c.integration_id), ['a', 'b']);
  assert.strictEqual(C.loadConfig().cfg.integration_id, 'a');
});

test('pairing the same integration again replaces it instead of duplicating', () => {
  const { C } = fresh();
  C.saveConfig(conn('a', 'Old'));
  C.saveConfig(conn('a', 'New'));
  const l = C.loadAll();
  assert.strictEqual(l.connections.length, 1);
  assert.strictEqual(l.connections[0].company_name, 'New');
});

test('a v0.3 single-connection config.json still loads, and gains a company when another is paired', () => {
  const { dir, C } = fresh();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(conn('old', 'Gomant')));
  assert.strictEqual(C.loadAll().connections.length, 1);
  C.saveConfig(conn('b', 'Royal Spirits South'));
  assert.deepStrictEqual(C.loadAll().connections.map(c => c.integration_id), ['old', 'b']);
});

test('a connection missing its endpoints is reported, not silently run', () => {
  const { dir, C } = fresh();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ connections: [conn('a', 'X'), { integration_id: 'b' }] }));
  assert.match(C.loadAll().error, /missing required fields/);
});
