/**
 * Sarvam AI — Speech-to-Text (Saarika) batch client.
 *
 * We use the BATCH job flow (not the sync /speech-to-text endpoint, which caps
 * at ~30s) because a sales conversation runs minutes and we want speaker
 * diarization (rep vs customer, for talk-ratio). Flow, per Sarvam's batch API:
 *
 *   1. init   POST /speech-to-text/job/init      -> { job_id, input_storage_path, output_storage_path }
 *   2. upload PUT  <input_storage_path>/<file>   (Azure blob; x-ms-blob-type: BlockBlob)
 *   3. start  POST /speech-to-text/job           { job_id, job_parameters:{ model, with_diarization, language_code } }
 *   4. poll   GET  /speech-to-text/job/<job_id>  until job_state === 'Completed' | 'Failed'
 *   5. output GET  <output_storage_path>/<file>.json  -> { transcript, diarized_transcript }
 *
 * Auth: header `api-subscription-key: <SARVAM_API_KEY>`.
 *
 * NOTE: the exact endpoint paths / field names follow Sarvam's documented batch
 * API but MUST be smoke-tested once SARVAM_API_KEY is live — the constants below
 * are the only things that would change if their wire shape differs. Everything
 * downstream (parsing, storage, analysis) is decoupled from Sarvam via the
 * TranscriptResult contract.
 */
const BASE = process.env.SARVAM_BASE_URL || 'https://api.sarvam.ai';
const MODEL = process.env.SARVAM_STT_MODEL || 'saarika:v2.5';
const KEY = () => process.env.SARVAM_API_KEY || '';

export interface DiarizedSegment {
  speaker: string;        // e.g. 'SPEAKER_00' / 'SPEAKER_01'
  text: string;
  start?: number;         // seconds
  end?: number;
}
export interface TranscriptResult {
  transcript: string;
  segments: DiarizedSegment[];
  language: string | null;
  jobId: string | null;
}

export function sarvamConfigured(): boolean {
  return !!KEY();
}

async function sarvamFetch(path: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'api-subscription-key': KEY(), ...(init.headers || {}) },
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Transcribe an audio buffer with diarization. Returns a normalized transcript
 * + speaker segments. Throws on hard failure; the caller marks the recording
 * 'failed' and stores the message.
 */
export async function transcribe(opts: {
  audio: Buffer;
  filename: string;
  languageCode?: string;   // 'unknown' lets Saarika auto-detect (Hindi/Hinglish/…)
  diarize?: boolean;
}): Promise<TranscriptResult> {
  if (!sarvamConfigured()) throw new Error('SARVAM_API_KEY not configured');
  const language = opts.languageCode || 'unknown';
  const diarize = opts.diarize !== false;

  // 1) init job
  const initRes = await sarvamFetch('/speech-to-text/job/init', { method: 'POST' });
  if (!initRes.ok) throw new Error(`Sarvam init failed (${initRes.status}): ${await safeText(initRes)}`);
  const init: any = await initRes.json();
  const jobId: string = init.job_id || init.jobId || init.id;
  const inputPath: string = init.input_storage_path || init.input_storage_url;
  const outputPath: string = init.output_storage_path || init.output_storage_url;
  if (!jobId || !inputPath) throw new Error('Sarvam init returned no job_id/input_storage_path');

  // 2) upload audio to the presigned (Azure blob) input path
  const uploadUrl = joinBlob(inputPath, opts.filename);
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/octet-stream' },
    body: opts.audio,
  });
  if (!putRes.ok) throw new Error(`Sarvam upload failed (${putRes.status})`);

  // 3) start the job
  const startRes = await sarvamFetch('/speech-to-text/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: jobId,
      job_parameters: { model: MODEL, with_diarization: diarize, language_code: language },
    }),
  });
  if (!startRes.ok) throw new Error(`Sarvam start failed (${startRes.status}): ${await safeText(startRes)}`);

  // 4) poll (bounded ~5 min: batch STT for a few-minute clip is typically < 1 min)
  let state = 'Pending';
  for (let i = 0; i < 60; i++) {
    await sleep(5_000);
    const st = await sarvamFetch(`/speech-to-text/job/${jobId}`, { method: 'GET' });
    if (!st.ok) continue;
    const j: any = await st.json();
    state = j.job_state || j.status || state;
    if (/complete/i.test(state)) break;
    if (/fail|error/i.test(state)) throw new Error(`Sarvam job failed: ${state}`);
  }
  if (!/complete/i.test(state)) throw new Error('Sarvam job timed out');

  // 5) fetch the output JSON
  const outUrl = joinBlob(outputPath, replaceExt(opts.filename, 'json'));
  const outRes = await fetch(outUrl);
  if (!outRes.ok) throw new Error(`Sarvam output fetch failed (${outRes.status})`);
  const out: any = await outRes.json();
  return normalize(out, jobId);
}

/** Map Sarvam's output JSON into our normalized contract, defensively. */
function normalize(out: any, jobId: string): TranscriptResult {
  const transcript: string = out.transcript || out.text || '';
  const language: string | null = out.language_code || out.language || null;
  const raw = out.diarized_transcript?.entries || out.diarized_transcript || out.segments || [];
  const segments: DiarizedSegment[] = Array.isArray(raw)
    ? raw.map((e: any) => ({
        speaker: e.speaker_id || e.speaker || 'SPEAKER',
        text: e.transcript || e.text || '',
        start: numOrUndef(e.start_time_seconds ?? e.start),
        end: numOrUndef(e.end_time_seconds ?? e.end),
      })).filter((s: DiarizedSegment) => s.text)
    : [];
  // If diarization is absent, fall back to the flat transcript as one segment.
  if (!segments.length && transcript) segments.push({ speaker: 'SPEAKER', text: transcript });
  return { transcript: transcript || segments.map((s) => s.text).join(' '), segments, language, jobId };
}

function joinBlob(base: string, file: string): string {
  // Azure SAS URLs put the token in the query string; insert the filename into
  // the path before the '?'.
  const [pathPart, query] = base.split('?');
  const sep = pathPart.endsWith('/') ? '' : '/';
  return `${pathPart}${sep}${encodeURIComponent(file)}${query ? '?' + query : ''}`;
}
function replaceExt(name: string, ext: string): string {
  const i = name.lastIndexOf('.');
  return (i >= 0 ? name.slice(0, i) : name) + '.' + ext;
}
function numOrUndef(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
async function safeText(r: Response): Promise<string> {
  try { return (await r.text()).slice(0, 300); } catch { return ''; }
}
