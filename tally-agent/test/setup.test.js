'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const S = require('../lib/setup');

const listen = (h) => new Promise(r => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r(s)); });
const body = (req) => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });

// A fake Kinematic API: only code K7F29X is valid; anything else gets the real server's 404 message.
async function fakeApi() {
  const seen = [];
  const s = await listen(async (req, res) => {
    const b = JSON.parse(await body(req) || '{}');
    seen.push(b.code);
    res.setHeader('Content-Type', 'application/json');
    if (String(b.code).toUpperCase().replace(/[^A-Z0-9]/g, '') === 'K7F29X') {
      return res.end(JSON.stringify({ ok: true, company_name: 'Gomant', config: { integration_id: 'i1', agent_secret: 's', polling_endpoint: 'http://x/jobs/i1?key=s', report_endpoint: 'http://x/r?key=s' } }));
    }
    res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'That code is invalid or has expired. Generate a new one in the dashboard.' }));
  });
  s.seen = seen; s.url = `http://127.0.0.1:${s.address().port}`;
  return s;
}

function deps({ installed = true, reachable = true } = {}) {
  const saved = [];
  return {
    saved,
    config: { DEFAULT_SERVER: 'unused', saveConfig: (c) => { saved.push(c); return '/data/config.json'; } },
    install: { install: () => installed },
    agent: { newContext: () => ({}), sendProfile: async () => (reachable ? { tally_reachable: true, companies: ['Gomant'] } : { tally_reachable: false, tally_error: 'Cannot connect to Tally.' }) },
  };
}
const collector = () => { const out = []; return { out, say: m => out.push(m), log: m => out.push(m) }; };
const scripted = (answers) => { const q = [...answers]; const asked = []; return { asked, ask: async (p) => { asked.push(p); return q.length ? q.shift() : ''; } }; };

test('pairAndInstall: valid code saves config, installs and reports Tally status', async () => {
  const api = await fakeApi(); const d = deps(); const c = collector();
  const r = await S.pairAndInstall({ code: 'k7f-29x', server: api.url, log: c.log, deps: d });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.installed, true);
  assert.strictEqual(d.saved[0].integration_id, 'i1'); assert.strictEqual(d.saved[0].company_name, 'Gomant');
  api.close();
});

test('pairAndInstall: bad code returns the server message; unreachable server returns a friendly one', async () => {
  const api = await fakeApi(); const c = collector();
  const bad = await S.pairAndInstall({ code: 'NOPE00', server: api.url, log: c.log, deps: deps() });
  assert.strictEqual(bad.ok, false); assert.match(bad.error, /invalid or has expired/);
  api.close();
  const down = await S.pairAndInstall({ code: 'K7F-29X', server: 'http://127.0.0.1:1', log: c.log, deps: deps() });
  assert.strictEqual(down.ok, false); assert.match(down.error, /internet connection/);
});

test('double-click flow: asks for the code, retries after a wrong one, then succeeds', async () => {
  const api = await fakeApi(); const c = collector(); const a = scripted(['WRONG1', 'K7F-29X']);
  const d = deps(); d.config.DEFAULT_SERVER = api.url;
  const r = await S.interactive({ ask: a.ask, say: c.say, log: c.log, deps: d, existingConfig: null, platform: 'win32' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(api.seen, ['WRONG1', 'K7F-29X']);
  const text = c.out.join('\n');
  assert.match(text, /Could not pair: That code is invalid/);
  assert.match(text, /start automatically whenever this PC starts/);
  assert.match(text, /Tally is reachable/);
  api.close();
});

test('double-click flow: gives up politely after 3 wrong codes', async () => {
  const api = await fakeApi(); const c = collector(); const a = scripted(['A1', 'B2', 'C3']);
  const d = deps(); d.config.DEFAULT_SERVER = api.url;
  const r = await S.interactive({ ask: a.ask, say: c.say, log: c.log, deps: d, existingConfig: null, platform: 'win32' });
  assert.strictEqual(r.ok, false);
  assert.match(c.out.join('\n'), /Too many attempts/);
  api.close();
});

test('double-click flow: already paired -> reassures, does nothing unless a new code is typed', async () => {
  const api = await fakeApi(); const c = collector(); const a = scripted(['']);
  const d = deps(); d.config.DEFAULT_SERVER = api.url;
  const r = await S.interactive({ ask: a.ask, say: c.say, log: c.log, deps: d, existingConfig: { integration_id: 'x' }, platform: 'win32' });
  assert.strictEqual(r.skipped, true); assert.deepStrictEqual(api.seen, []);
  assert.match(c.out.join('\n'), /already paired/);
  api.close();
});

test('double-click flow: paired but auto-start could not be registered -> says how to fix it', async () => {
  const api = await fakeApi(); const c = collector(); const a = scripted(['K7F-29X']);
  const d = deps({ installed: false, reachable: false }); d.config.DEFAULT_SERVER = api.url;
  const r = await S.interactive({ ask: a.ask, say: c.say, log: c.log, deps: d, existingConfig: null, platform: 'win32' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.installed, false);
  const text = c.out.join('\n');
  assert.match(text, /Run as administrator/); assert.match(text, /Tally is not reachable yet/);
  api.close();
});

test('a failed status report is not blamed on Tally', async () => {
  const api = await fakeApi(); const c = collector(); const a = scripted(['K7F-29X']);
  const d = deps(); d.config.DEFAULT_SERVER = api.url;
  d.agent.sendProfile = async () => { throw new Error('fetch failed'); };
  await S.interactive({ ask: a.ask, say: c.say, log: c.log, deps: d, existingConfig: null, platform: 'linux' });
  const text = c.out.join('\n');
  assert.match(text, /status report to Kinematic did not go through/);
  assert.doesNotMatch(text, /Tally is not reachable/);
  api.close();
});

test('tidyCode keeps just the code when the whole command was pasted', () => {
  assert.strictEqual(S.tidyCode('kinematic-tally-agent.exe pair CCG-4DR'), 'CCG-4DR');
  assert.strictEqual(S.tidyCode('  K7F-29X  '), 'K7F-29X');
  assert.strictEqual(S.tidyCode(''), '');
  assert.strictEqual(S.tidyCode(undefined), '');
});

test('double-click flow accepts a pasted full command', async () => {
  const api = await fakeApi(); const c = collector(); const a = scripted(['kinematic-tally-agent.exe pair K7F-29X']);
  const d = deps(); d.config.DEFAULT_SERVER = api.url;
  const r = await S.interactive({ ask: a.ask, say: c.say, log: c.log, deps: d, existingConfig: null, platform: 'win32' });
  assert.strictEqual(r.ok, true); assert.deepStrictEqual(api.seen, ['K7F-29X']);
  api.close();
});
