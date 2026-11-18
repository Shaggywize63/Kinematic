/**
 * WhatsApp voice note → CRM lead (Client Management → WhatsApp alerts → "Reps can add leads by voice note").
 *
 * A field rep sends a voice note to their company's WhatsApp number, e.g. "New lead, Ravi Sharma from Sharma Traders,
 * 98765 43210, Andheri, wants 20 cartons next week". The CRM:
 *   1. recognises the sender as an active user of the org (users.mobile),
 *   2. downloads the audio from Meta and transcribes it (Sarvam, auto-detects Hindi / Hinglish / other Indian languages),
 *   3. pulls the lead's details out of the transcript (extractLead, the same extractor the apps' voice capture uses),
 *   4. creates the lead, or fills in an existing one with the same phone / email, owned by the rep,
 *   5. replies on WhatsApp with what it saved.
 * A text message starting with "lead" (e.g. "lead Ravi Sharma, Sharma Traders, 9876543210") works the same way, minus
 * the transcription.
 *
 * Off by default (setting `voice_leads` in org_settings `notifications.whatsapp`). Messages from anyone who is not an
 * active user of the org are ignored here and handled as before. Runs detached from the webhook so Meta (and the KINI
 * bot, which forwards with a short timeout) get their 200 at once; AsyncLocalStorage keeps the tenant's project.
 */
import { supabaseAdmin } from '../../lib/supabase';
import { logger } from '../../lib/logger';
import { cloudApiCredentials } from './whatsappConnection.service';
import { GRAPH_VERSION } from './providers/cloudApiWhatsapp.provider';
import { sendWhatsapp } from './whatsapp.service';
import { transcribe, sarvamConfigured } from '../integrations/sarvam';
import { extractLead, type ExtractedLead } from './ai/extractLead.service';
import { findOrCreateLead } from './integrations/dedup.orchestrator';
import { checkQuota, recordQuery } from './ai/kiniQuota.service';
import { WA_SETTING_KEY, toSettings } from '../clientWhatsappAlerts.service';

export const SOURCE_NAME = 'WhatsApp Voice (KINI)';
const MAX_AUDIO_BYTES = 16 * 1024 * 1024; // WhatsApp's own limit for audio
const DEDUP_MS = 10 * 60_000;
/** "lead …", "new lead: …", "Lead - …" */
const LEAD_TEXT = /^\s*(new\s+)?lead\b\s*[:\-–]?\s*/i;

export interface InboundMessage {
  id?: string;
  from: string;
  type?: string;
  text?: { body?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
}

export interface Rep { id: string; name: string | null; client_id: string | null; role: string | null; org_id: string }

const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/** Is this message something we should turn into a lead (before checking who sent it)? */
export function leadMessageKind(m: InboundMessage): 'audio' | 'text' | null {
  if ((m.type === 'audio' || m.type === 'voice') && m.audio?.id) return 'audio';
  if (m.type === 'text' && LEAD_TEXT.test(m.text?.body ?? '') && (m.text?.body ?? '').replace(LEAD_TEXT, '').trim().length >= 3) return 'text';
  return null;
}

/** The active user of the org with this WhatsApp number, or null. Only digits reach the PostgREST filter. */
export async function findRepByPhone(orgId: string, from: string): Promise<Rep | null> {
  const last10 = digits(from).slice(-10);
  if (last10.length !== 10) return null;
  const { data, error } = await supabaseAdmin.from('users')
    .select('id, name, client_id, role, org_id')
    .eq('org_id', orgId).eq('is_active', true).is('deleted_at', null)
    .or(`mobile.eq.${last10},mobile.eq.+91${last10},mobile.eq.91${last10},mobile.eq.0${last10}`)
    .limit(1).maybeSingle();
  if (error || !data) return null;
  return data as Rep;
}

export async function voiceLeadsEnabled(orgId: string): Promise<boolean> {
  const { data } = await supabaseAdmin.from('org_settings').select('value').eq('org_id', orgId).eq('key', WA_SETTING_KEY).maybeSingle();
  return toSettings((data as { value?: unknown } | null)?.value).voice_leads;
}

/** Download a WhatsApp media object (Cloud API): GET /{media-id} for its URL, then GET that URL with the same token. */
export async function downloadWhatsappMedia(orgId: string, mediaId: string): Promise<{ audio: Buffer; mime: string } | null> {
  const creds = await cloudApiCredentials(orgId);
  if (!creds) return null;
  const auth = { Authorization: `Bearer ${creds.access_token}` };
  const meta = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(mediaId)}`, { headers: auth });
  const info = (await meta.json().catch(() => ({}))) as { url?: string; mime_type?: string; file_size?: number; error?: { message?: string } };
  if (!meta.ok || !info.url) throw new Error(info.error?.message || `media lookup HTTP ${meta.status}`);
  if (info.file_size && info.file_size > MAX_AUDIO_BYTES) throw new Error('voice note too large');
  const res = await fetch(info.url, { headers: auth });
  if (!res.ok) throw new Error(`media download HTTP ${res.status}`);
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length > MAX_AUDIO_BYTES) throw new Error('voice note too large');
  return { audio, mime: info.mime_type || 'audio/ogg' };
}

async function voiceSourceId(orgId: string): Promise<string | null> {
  const { data: existing } = await supabaseAdmin.from('crm_lead_sources')
    .select('id').eq('org_id', orgId).eq('name', SOURCE_NAME).is('deleted_at', null).limit(1).maybeSingle();
  if ((existing as { id?: string } | null)?.id) return (existing as { id: string }).id;
  const { data: created, error } = await supabaseAdmin.from('crm_lead_sources').insert({ org_id: orgId, name: SOURCE_NAME, is_active: true }).select('id').single();
  if (error) { logger.warn(`[voice-lead] source create failed org=${orgId}: ${error.message}`); return null; }
  return (created as { id?: string } | null)?.id ?? null;
}

const fmtPhone = (p: string | null) => (p && p.length === 10 ? `${p.slice(0, 5)} ${p.slice(5)}` : p);

/** The confirmation the rep gets back. */
export function confirmation(x: ExtractedLead, wasNew: boolean): string {
  const name = [x.first_name, x.last_name].filter(Boolean).join(' ') || 'Unnamed lead';
  const where = [x.city, x.state].filter(Boolean).join(', ');
  const bits = [x.company, fmtPhone(x.phone), x.email, where].filter(Boolean);
  return `${wasNew ? '✅ Lead created' : '✅ Added to the existing lead'}: *${name}*${bits.length ? `\n${bits.join(' · ')}` : ''}` +
    `${x.notes ? `\nNote: ${x.notes.slice(0, 200)}` : ''}\nOwner: you. Fix anything in the Kinematic app.`;
}

const seen = new Map<string, number>();
/** Test seam. */
export const _resetVoiceLeadState = (): void => seen.clear();

export type VoiceLeadOutcome =
  | 'ignored' | 'disabled' | 'not_rep' | 'duplicate' | 'quota' | 'no_audio' | 'no_transcript' | 'no_details' | 'created' | 'updated' | 'failed';

/**
 * Turn a rep's voice note / "lead …" text into a lead. Never throws; every early exit after the sender is known to be
 * a rep gets a short WhatsApp reply so the rep is never left guessing. Runs in the CURRENT project.
 */
export async function handleRepLeadMessage(orgId: string, m: InboundMessage): Promise<VoiceLeadOutcome> {
  const kind = leadMessageKind(m);
  if (!kind) return 'ignored';
  const reply = (body_text: string, lead_id?: string | null, user_id?: string) =>
    sendWhatsapp({ org_id: orgId, to: m.from, body_text, lead_id: lead_id ?? null, user_id }).catch(() => undefined);
  try {
    if (!(await voiceLeadsEnabled(orgId))) return 'disabled';
    const rep = await findRepByPhone(orgId, m.from);
    if (!rep) return 'not_rep';

    const key = `${orgId}|${m.id ?? `${m.from}|${m.text?.body ?? m.audio?.id}`}`;
    const now = Date.now();
    for (const [k, at] of seen) if (now - at > DEDUP_MS) seen.delete(k);
    if (seen.has(key)) return 'duplicate';
    seen.set(key, now);

    const quota = await checkQuota({ id: rep.id, org_id: rep.org_id, client_id: rep.client_id, role: rep.role });
    if (!quota.allowed) {
      await reply("Your team's KINI limit for this month is used up, so I couldn't create this lead. Please add it in the Kinematic app.");
      return 'quota';
    }

    let transcript: string;
    if (kind === 'text') {
      transcript = (m.text?.body ?? '').replace(LEAD_TEXT, '').trim();
    } else {
      if (!sarvamConfigured()) {
        await reply("Voice notes aren't set up for your account yet. Send the details as text starting with \"lead\", e.g. lead Ravi Sharma, Sharma Traders, 9876543210.");
        return 'no_audio';
      }
      const media = await downloadWhatsappMedia(orgId, m.audio!.id!).catch((e) => { logger.warn(`[voice-lead] download failed org=${orgId}: ${e?.message || e}`); return null; });
      if (!media) {
        await reply("I couldn't open that voice note. Please send it again, or type the details starting with \"lead\".");
        return 'no_audio';
      }
      await reply('🎙️ Got your voice note. Creating the lead, this takes about a minute.');
      const t = await transcribe({ audio: media.audio, filename: 'voice-note.ogg', languageCode: 'unknown', diarize: false });
      transcript = (t.transcript || '').trim();
    }
    if (!transcript) {
      await reply("I couldn't hear anything in that voice note. Please record it again a little closer to the phone.");
      return 'no_transcript';
    }

    const x = await extractLead(transcript, false, orgId, rep.client_id);
    await recordQuery({ id: rep.id, org_id: rep.org_id, client_id: rep.client_id, role: rep.role }).catch(() => undefined);
    if (!x.first_name && !x.last_name && !x.phone && !x.email && !x.company) {
      await reply(`I couldn't find the customer's name or mobile number in that. Please include both and send again.\nI heard: "${transcript.slice(0, 300)}"`);
      return 'no_details';
    }

    const source_id = await voiceSourceId(orgId);
    if (!source_id) throw new Error('no lead source');
    const notes = [x.notes, `Voice note from ${rep.name ?? 'rep'} on WhatsApp: "${transcript.slice(0, 1500)}"`].filter(Boolean).join('\n');
    const res = await findOrCreateLead({
      org_id: orgId,
      source_id,
      user_id: rep.id,
      owner_id: rep.id,
      client_id: rep.client_id ?? undefined,
      normalized: {
        first_name: x.first_name, last_name: x.last_name, phone: x.phone, email: x.email, company: x.company,
        title: x.title, industry: x.industry, city: x.city, state: x.state, country: x.country,
        address_line1: x.address_line1, postal_code: x.postal_code, alternate_mobiles: x.alternate_mobiles ?? undefined,
        custom_fields: x.custom_fields ?? undefined, notes,
      },
    });
    await reply(confirmation(x, res.was_new), res.lead_id, rep.id);
    return res.was_new ? 'created' : 'updated';
  } catch (e: any) {
    logger.error(`[voice-lead] org=${orgId} failed: ${e?.message || e}`);
    await reply("Sorry, I couldn't create that lead. Please try again, or add it in the Kinematic app.");
    return 'failed';
  }
}
