jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  (global as any).__supa = m;
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/services/crm/whatsapp.service', () => ({
  sendWhatsapp: jest.fn(async () => ({ id: 'log-1', provider_message_id: 'wamid.out', status: 'sent', error: null })),
}));
jest.mock('../src/services/crm/whatsappConnection.service', () => ({
  cloudApiCredentials: jest.fn(async () => ({ phone_number_id: '123', access_token: 'tok' })),
}));
jest.mock('../src/services/integrations/sarvam', () => ({
  sarvamConfigured: jest.fn(() => true),
  transcribe: jest.fn(async () => ({ transcript: 'Naya lead, Ravi Sharma, Sharma Traders, 98765 43210, Andheri', segments: [], language: 'hi-IN', jobId: 'j1' })),
}));
jest.mock('../src/services/crm/ai/extractLead.service', () => ({
  extractLead: jest.fn(),
}));
jest.mock('../src/services/crm/integrations/dedup.orchestrator', () => ({
  findOrCreateLead: jest.fn(async () => ({ lead_id: 'lead-1', was_new: true })),
}));
jest.mock('../src/services/crm/ai/kiniQuota.service', () => ({
  checkQuota: jest.fn(async () => ({ allowed: true })),
  recordQuery: jest.fn(async () => undefined),
}));

import {
  handleRepLeadMessage, leadMessageKind, confirmation, _resetVoiceLeadState, SOURCE_NAME, type InboundMessage,
} from '../src/services/crm/whatsappVoiceLead.service';
import { sendWhatsapp } from '../src/services/crm/whatsapp.service';
import { transcribe, sarvamConfigured } from '../src/services/integrations/sarvam';
import { extractLead } from '../src/services/crm/ai/extractLead.service';
import { findOrCreateLead } from '../src/services/crm/integrations/dedup.orchestrator';
import { checkQuota } from '../src/services/crm/ai/kiniQuota.service';
import { cloudApiCredentials } from '../src/services/crm/whatsappConnection.service';

const supa = () => (global as any).__supa;
const send = sendWhatsapp as jest.Mock;
const ORG = 'org-client';
const REP = { id: 'u-rep', name: 'Asha Rao', client_id: 'c-1', role: 'executive', org_id: ORG };
const extracted = {
  first_name: 'Ravi', last_name: 'Sharma', phone: '9876543210', alternate_mobiles: null, email: null, company: 'Sharma Traders',
  title: null, industry: null, date_of_birth: null, gender: null, address_line1: null, city: 'Mumbai', state: null,
  postal_code: null, country: null, preferred_contact_method: null, notes: 'Wants 20 cartons next week', source_hint: null, custom_fields: null,
};

const audio = (id = 'wamid.in1'): InboundMessage => ({ id, from: '919811112222', type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg; codecs=opus', voice: true } });
const text = (body: string, id = 'wamid.t1'): InboundMessage => ({ id, from: '919811112222', type: 'text', text: { body } });

const realFetch = global.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  supa().reset();
  _resetVoiceLeadState();
  jest.clearAllMocks();
  (extractLead as jest.Mock).mockResolvedValue(extracted);
  (cloudApiCredentials as jest.Mock).mockResolvedValue({ phone_number_id: '123', access_token: 'tok' });
  (transcribe as jest.Mock).mockResolvedValue({ transcript: 'Naya lead, Ravi Sharma, Sharma Traders, 98765 43210, Andheri', segments: [], language: 'hi-IN', jobId: 'j1' });
  (sarvamConfigured as jest.Mock).mockReturnValue(true);
  (checkQuota as jest.Mock).mockResolvedValue({ allowed: true });
  (findOrCreateLead as jest.Mock).mockResolvedValue({ lead_id: 'lead-1', was_new: true });
  supa().setDefault('org_settings', { data: { value: { voice_leads: true } } });
  supa().setDefault('users', { data: REP });
  supa().setDefault('crm_lead_sources', { data: { id: 'src-voice' } });
  fetchMock = jest.fn(async (url: string) => (String(url).startsWith('https://graph.facebook.com/')
    ? { ok: true, status: 200, json: async () => ({ url: 'https://lookaside.fbsbx.com/whatsapp/media-1', mime_type: 'audio/ogg', file_size: 4000 }) }
    : { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }));
  global.fetch = fetchMock as any;
});
afterEach(() => { global.fetch = realFetch; });

describe('leadMessageKind', () => {
  it('picks voice notes and "lead …" texts only', () => {
    expect(leadMessageKind(audio())).toBe('audio');
    expect(leadMessageKind(text('lead Ravi Sharma, 9876543210'))).toBe('text');
    expect(leadMessageKind(text('New lead: Ravi'))).toBe('text');
    expect(leadMessageKind(text('hello there'))).toBeNull();
    expect(leadMessageKind(text('lead'))).toBeNull();
    expect(leadMessageKind(text('leader of the team called'))).toBeNull();
    expect(leadMessageKind({ from: '91', type: 'audio' })).toBeNull();
  });
});

describe('handleRepLeadMessage', () => {
  it('turns a rep\'s voice note into a lead they own, and confirms on WhatsApp', async () => {
    expect(await handleRepLeadMessage(ORG, audio())).toBe('created');

    // Media: metadata lookup, then download, both with the connection's token.
    expect(fetchMock.mock.calls[0][0]).toMatch(/graph\.facebook\.com\/v[\d.]+\/media-1$/);
    expect(fetchMock.mock.calls[1][0]).toBe('https://lookaside.fbsbx.com/whatsapp/media-1');
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ Authorization: 'Bearer tok' });
    expect((transcribe as jest.Mock).mock.calls[0][0]).toMatchObject({ filename: 'voice-note.ogg', languageCode: 'unknown', diarize: false });
    expect((extractLead as jest.Mock).mock.calls[0]).toEqual(['Naya lead, Ravi Sharma, Sharma Traders, 98765 43210, Andheri', false, ORG, 'c-1']);

    const lead = (findOrCreateLead as jest.Mock).mock.calls[0][0];
    expect(lead).toMatchObject({ org_id: ORG, source_id: 'src-voice', user_id: 'u-rep', owner_id: 'u-rep', client_id: 'c-1' });
    expect(lead.normalized).toMatchObject({ first_name: 'Ravi', last_name: 'Sharma', phone: '9876543210', company: 'Sharma Traders', city: 'Mumbai' });
    expect(lead.normalized.notes).toContain('Voice note from Asha Rao on WhatsApp: "Naya lead, Ravi Sharma');

    // Rep found by the last 10 digits, in this org, active only.
    const users = supa().chainsFor('users')[0];
    expect(users.eqs).toMatchObject({ org_id: ORG, is_active: true });
    expect(users.ors[0]).toBe('mobile.eq.9811112222,mobile.eq.+919811112222,mobile.eq.919811112222,mobile.eq.09811112222');

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].body_text).toMatch(/Got your voice note/);
    expect(send.mock.calls[1][0]).toMatchObject({ org_id: ORG, to: '919811112222', lead_id: 'lead-1', user_id: 'u-rep' });
    expect(send.mock.calls[1][0].body_text).toContain('✅ Lead created: *Ravi Sharma*');
  });

  it('takes a "lead …" text without transcribing', async () => {
    (findOrCreateLead as jest.Mock).mockResolvedValue({ lead_id: 'lead-9', was_new: false });
    expect(await handleRepLeadMessage(ORG, text('Lead: Ravi Sharma, Sharma Traders, 9876543210'))).toBe('updated');
    expect(transcribe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((extractLead as jest.Mock).mock.calls[0][0]).toBe('Ravi Sharma, Sharma Traders, 9876543210');
    expect(send.mock.calls[0][0].body_text).toContain('✅ Added to the existing lead');
  });

  it('ignores people who are not active users of the org, and orgs that have not switched it on', async () => {
    supa().setDefault('users', { data: null });
    expect(await handleRepLeadMessage(ORG, audio())).toBe('not_rep');
    supa().setDefault('org_settings', { data: { value: { voice_leads: false } } });
    expect(await handleRepLeadMessage(ORG, audio('wamid.x'))).toBe('disabled');
    expect(send).not.toHaveBeenCalled();
    expect(findOrCreateLead).not.toHaveBeenCalled();
  });

  it('handles the same message only once', async () => {
    expect(await handleRepLeadMessage(ORG, text('lead Ravi 9876543210'))).toBe('created');
    expect(await handleRepLeadMessage(ORG, text('lead Ravi 9876543210'))).toBe('duplicate');
    expect(findOrCreateLead).toHaveBeenCalledTimes(1);
  });

  it('asks again when it can\'t find a name or number', async () => {
    (extractLead as jest.Mock).mockResolvedValue({ ...extracted, first_name: null, last_name: null, phone: null, company: null });
    expect(await handleRepLeadMessage(ORG, text('lead call him tomorrow'))).toBe('no_details');
    expect(send.mock.calls[0][0].body_text).toMatch(/couldn't find the customer's name or mobile number/);
    expect(send.mock.calls[0][0].body_text).toContain('I heard: "call him tomorrow"');
    expect(findOrCreateLead).not.toHaveBeenCalled();
  });

  it('stops at the KINI limit, and when voice can\'t be transcribed', async () => {
    (checkQuota as jest.Mock).mockResolvedValueOnce({ allowed: false, reason: 'ORG_KINI_LIMIT_REACHED' });
    expect(await handleRepLeadMessage(ORG, text('lead Ravi 9876543210', 'wamid.q'))).toBe('quota');
    (sarvamConfigured as jest.Mock).mockReturnValue(false);
    expect(await handleRepLeadMessage(ORG, audio('wamid.s'))).toBe('no_audio');
    expect(send.mock.calls.map((c) => c[0].body_text)).toEqual([
      expect.stringMatching(/KINI limit for this month is used up/),
      expect.stringMatching(/Send the details as text starting with "lead"/),
    ]);
  });

  it('replies with an apology instead of failing silently', async () => {
    (findOrCreateLead as jest.Mock).mockRejectedValue(new Error('db down'));
    expect(await handleRepLeadMessage(ORG, text('lead Ravi 9876543210', 'wamid.f'))).toBe('failed');
    expect(send.mock.calls.at(-1)[0].body_text).toMatch(/couldn't create that lead/);
  });

  it('creates the "WhatsApp Voice (KINI)" source when missing', async () => {
    supa().setDefault('crm_lead_sources', (chain: any) => (chain.ops.some((o: any) => o.method === 'insert') ? { data: { id: 'src-new' } } : { data: null }));
    await handleRepLeadMessage(ORG, text('lead Ravi 9876543210', 'wamid.src'));
    const ins = supa().chainsFor('crm_lead_sources').find((c: any) => c.ops.some((o: any) => o.method === 'insert'));
    expect(ins.ops.find((o: any) => o.method === 'insert').args[0]).toEqual({ org_id: ORG, name: SOURCE_NAME, is_active: true });
    expect((findOrCreateLead as jest.Mock).mock.calls[0][0].source_id).toBe('src-new');
  });
});

describe('confirmation', () => {
  it('reads cleanly', () => {
    expect(confirmation(extracted as any, true)).toBe(
      '✅ Lead created: *Ravi Sharma*\nSharma Traders · 98765 43210 · Mumbai\nNote: Wants 20 cartons next week\nOwner: you. Fix anything in the Kinematic app.',
    );
  });
});
