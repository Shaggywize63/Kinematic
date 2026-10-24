'use strict';
// Pairing + the double-click (interactive) flow. Dependencies are injected so it can be tested.
const C = require('./config');

/** Be forgiving: if the whole command was pasted ("kinematic-tally-agent.exe pair K7F-29X"), keep just the code. */
function tidyCode(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** Exchange a pairing code for this PC's config, save it, register auto-start, report to the dashboard. */
async function pairAndInstall({ code, server, noInstall = false, log, deps = {} }) {
  const cfgMod = deps.config || C;
  const inst = deps.install || require('./install');
  const agent = deps.agent || require('./agent');
  const doFetch = deps.fetch || fetch;
  const base = String(server || process.env.KINEMATIC_SERVER || cfgMod.DEFAULT_SERVER).replace(/\/$/, '');

  let res, json;
  try {
    res = await doFetch(`${base}/api/v1/integrations/tally/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, error: `Could not reach ${base}. Check this PC's internet connection. (${e.message})` };
  }
  if (!res.ok || !json.ok) return { ok: false, error: json.error || `Pairing failed (HTTP ${res.status})` };

  const cfg = { ...json.config, company_name: json.company_name || null };
  const p = cfgMod.saveConfig(cfg);
  log(`Paired. Config saved to ${p}`);
  const installed = noInstall ? false : inst.install(log);

  const ctx = agent.newContext(cfg, log);
  // A failure here is about reaching Kinematic, not Tally: don't blame Tally for it. The connector retries by itself.
  const profile = await agent.sendProfile(ctx, cfg.company_name).catch(e => ({ report_failed: true, note: e.message }));
  return { ok: true, installed, profile };
}

function describeProfile(profile, say) {
  if (profile && profile.report_failed) {
    say('Paired, but the first status report to Kinematic did not go through. The connector will retry by itself in a minute.');
    say(`(${profile.note})`);
  } else if (profile && profile.tally_reachable) {
    say(`Tally is reachable. Companies open: ${(profile.companies || []).join(', ') || '(none)'}`);
  } else {
    say('Tally is not reachable yet' + (profile && profile.tally_error ? `: ${profile.tally_error}` : '.'));
    say('Open Tally with your company, and turn on F1 > Settings > Connectivity > Client/Server (TallyPrime acts as = Both, port 9000).');
    say('The dashboard checklist will show what is left to fix.');
  }
}

/**
 * What happens when the .exe is double-clicked: ask for the pairing code (up to 3 tries), pair,
 * install, say what to do next. The caller keeps the window open afterwards.
 */
async function interactive({ ask, say, log, deps = {}, existingConfig, platform = process.platform }) {
  say('');
  say('==============================================');
  say('  Kinematic Tally Connector');
  say('==============================================');

  if (existingConfig) {
    const have = Array.isArray(existingConfig) ? existingConfig : [existingConfig];
    say(`This PC is already paired with Kinematic (${have.map(c => c.company_name || 'a company').join(', ')}).`);
    say('The connector runs in the background and starts with Windows - nothing more to do here.');
    say('To connect another company, type its pairing code now (it is added beside the existing ones); otherwise just press Enter.');
    const again = (await ask('Pairing code for another company (or Enter to skip): ')).trim();
    if (!again) return { ok: true, skipped: true };
    return pairLoop({ first: again, ask, say, log, deps, platform });
  }

  say('Welcome. To connect Tally to Kinematic you need the 6-character pairing code');
  say('shown in the Kinematic dashboard (Distribution > Integrations > Set up & sync).');
  say('');
  return pairLoop({ ask, say, log, deps, platform });
}

async function pairLoop({ first, ask, say, log, deps, platform }) {
  let code = tidyCode(first);
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!code) code = tidyCode(await ask('Enter the pairing code (for example K7F-29X): '));
    if (!code) { say('No code entered.'); continue; }
    const r = await pairAndInstall({ code, log, deps });
    if (r.ok) {
      say('');
      if (!r.installed && platform === 'win32') {
        say('NOTE: paired, but the auto-start task could not be created. Close this window, then right-click');
        say('the file and choose "Run as administrator", and enter the code again (or ask us for help).');
      } else if (r.installed) {
        say('Done. The connector will start automatically whenever this PC starts.');
      }
      describeProfile(r.profile, say);
      say('');
      say('Now go back to the Kinematic dashboard - the checklist updates by itself.');
      return { ok: true, installed: r.installed, profile: r.profile };
    }
    say(`Could not pair: ${r.error}`);
    code = '';
  }
  say('Too many attempts. Generate a new code in the dashboard and run this again.');
  return { ok: false };
}

module.exports = { pairAndInstall, interactive, describeProfile, tidyCode };
