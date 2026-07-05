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
// Sarvam's live batch API doesn't always match the documented enum names. Match
// on any of the common success/failure signatures; the real value gets logged
// verbatim on timeout so we can tighten this the moment a new one shows up.
const OK_STATE_RE = /complete|succe|success|done|finish|ready/i;
const FAIL_STATE_RE = /fail|error|cancel|abort|reject/i;

export async function transcribe(opts: {
  audio: Buffer;
  filename: string;
  languageCode?: string;   // 'unknown' lets Saarika auto-detect (Hindi/Hinglish/…)
  diarize?: boolean;
  // Fires as soon as we have a job_id (before upload/start/poll). Lets the
  // caller persist the id to the DB so a later failure is still traceable to
  // the specific Sarvam job. Awaited but errors ignored — persistence issues
  // must not abort the transcription.
  onJob?: (jobId: string) => Promise<void> | void;
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

  if (opts.onJob) { try { await opts.onJob(jobId); } catch { /* persistence hiccup must not abort */ } }

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

  // 4) poll (bounded ~7.5 min: batch STT for a few-minute clip is typically < 1 min)
  // Live-API reality: my originally-documented status path returns non-2xx on
  // every poll, so try a handful of common variants. Whichever first returns
  // 200 becomes the winner for the rest of the loop. If ALL fail every round,
  // the timeout error includes each variant's status code + body snippet so we
  // can fix it precisely on the next iteration instead of guessing.
  const STATUS_PATH_VARIANTS = [
    `/speech-to-text/job/${jobId}/status`,
    `/speech-to-text/job/${jobId}`,
    `/speech-to-text/job-status/${jobId}`,
    `/speech-to-text/jobs/${jobId}`,
    `/speech-to-text/jobs/${jobId}/status`,
  ];
  let statusPath: string | null = null;
  let state = 'Pending';
  let lastBody = '';
  let lastStatus = 0;
  const failureSummaries: string[] = [];
  for (let i = 0; i < 90; i++) {
    await sleep(5_000);
    if (statusPath) {
      const st = await sarvamFetch(statusPath, { method: 'GET' });
      lastStatus = st.status;
      try { lastBody = await st.text(); } catch { lastBody = ''; }
      if (!st.ok) continue;
    } else {
      // Round-robin over variants until one returns 200; then pin it for the
      // rest of the loop so we're not paying the extra RTTs every 5s.
      let picked = false;
      const roundFailures: string[] = [];
      for (const cand of STATUS_PATH_VARIANTS) {
        const st = await sarvamFetch(cand, { method: 'GET' });
        lastStatus = st.status;
        try { lastBody = await st.text(); } catch { lastBody = ''; }
        if (st.ok) {
          statusPath = cand;
          picked = true;
          break;
        }
        roundFailures.push(`${cand}→${st.status}${lastBody ? ' body="' + lastBody.slice(0, 80).replace(/\s+/g, ' ') + '"' : ''}`);
      }
      if (!picked) {
        // Keep only the most recent round's failures — one line each.
        failureSummaries.length = 0;
        failureSummaries.push(...roundFailures);
        continue;
      }
    }
    let j: any = {};
    try { j = JSON.parse(lastBody); } catch { /* state stays as last known */ }
    // Sarvam's actual response shape isn't fully stable — check every field
    // path we've seen in the wild + the documented one.
    const raw = j.job_state ?? j.status ?? j.state ?? j.job?.status ?? j.job?.state ?? j.data?.status ?? '';
    if (raw) state = String(raw);
    if (OK_STATE_RE.test(state)) break;
    if (FAIL_STATE_RE.test(state)) throw new Error(`Sarvam job failed: state='${state}' body='${lastBody.slice(0, 200).replace(/\s+/g, ' ')}'`);
  }
  if (!OK_STATE_RE.test(state)) {
    const diag = statusPath
      ? `path='${statusPath}' last_status=${lastStatus} last_body='${lastBody.slice(0, 200).replace(/\s+/g, ' ')}'`
      : `all-paths-failed: ${failureSummaries.join(' | ')}`;
    throw new Error(`Sarvam job timed out: jobId=${jobId} last_state='${state}' ${diag}`);
  }

  // 5) fetch the output JSON — in order of preference:
  //    (a) transcript already in the completion payload → skip network entirely
  //    (b) explicit output URL in the completion payload
  //    (c) filename guessing at output_storage_path (with fallbacks)
  try {
    const j: any = JSON.parse(lastBody);
    const payload = j.data ?? j;
    // Inline: the poll response IS the result. Many batch APIs do this.
    const inlineTranscript = payload.transcript ?? payload.text ?? payload.diarized_transcript;
    if (inlineTranscript !== undefined && inlineTranscript !== null) {
      return normalize(payload, jobId);
    }
    // Explicit URL in the completion payload.
    const explicit: string | undefined = payload.output_url ?? payload.output_file_url
      ?? payload.result_url ?? payload.data?.output_url ?? payload.outputs?.[0]?.url;
    if (typeof explicit === 'string' && /^https?:\/\//i.test(explicit)) {
      const r = await fetch(explicit);
      if (r.ok) return normalize(await r.json(), jobId);
    }
  } catch { /* fall through to filename guessing */ }

  const inputBase = opts.filename.replace(/\.[^.]+$/, '');
  const OUTPUT_FILENAME_VARIANTS = Array.from(new Set([
    replaceExt(opts.filename, 'json'),   // audio.m4a → audio.json
    `${inputBase}.txt`,
    'transcript.json', 'output.json', 'result.json',
    `${jobId}.json`, `${jobId}`,
  ]));
  const outputAttempts: string[] = [];
  for (const filename of OUTPUT_FILENAME_VARIANTS) {
    const candUrl = joinBlob(outputPath, filename);
    const r = await fetch(candUrl);
    if (r.ok) return normalize(await r.json(), jobId);
    outputAttempts.push(`${filename}→${r.status}`);
  }
  throw new Error(`Sarvam output fetch failed — tried: ${outputAttempts.join(' | ')} at path='${outputPath.slice(0, 120)}'`);
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
