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

  // 5) fetch the output JSON. Sarvam's real output shape has proven unstable
  //    across jobs, so we (a) gather every plausible output blob, (b) run a
  //    DEEP, shape-tolerant extractor over each, and (c) only accept a result
  //    that actually yields a non-empty transcript. If a payload is fetched but
  //    yields nothing, we FAIL with a snippet of its raw JSON — we never
  //    silently store an empty transcript — so the true field structure is
  //    captured and the next fix is exact.
  const diag: string[] = [];
  let rawDiag = '';

  // (a) Inline: the completion payload itself may carry the transcript.
  try {
    const j: any = JSON.parse(lastBody);
    const payload = j.data ?? j;
    const inline = tryNormalize(payload, jobId);
    if (inline) return inline;
    if (payload && typeof payload === 'object' && Object.keys(payload).length) rawDiag ||= `inline: ${snippet(payload)}`;

    // Explicit output URL in the completion payload.
    const explicit: string | undefined = payload.output_url ?? payload.output_file_url
      ?? payload.result_url ?? payload.data?.output_url ?? payload.outputs?.[0]?.url;
    if (typeof explicit === 'string' && /^https?:\/\//i.test(explicit)) {
      const r = await fetch(explicit);
      if (r.ok) {
        const out = await r.json().catch(() => null);
        const norm = out && tryNormalize(out, jobId);
        if (norm) return norm;
        if (out) rawDiag ||= `explicit: ${snippet(out)}`;
      }
    }
  } catch { /* fall through */ }

  // (b) PRIMARY: list the Azure output "directory" and try EVERY candidate blob
  //     — some jobs write a manifest/status JSON alongside the transcript JSON,
  //     so accepting only the first would silently yield an empty transcript.
  const listing = await fetchAzureOutputByListing(outputPath);
  for (const cand of listing.candidates) {
    const norm = tryNormalize(cand.json, jobId);
    if (norm) return norm;
    rawDiag ||= `${cand.name}: ${snippet(cand.json)}`;
  }
  diag.push(`listing(status=${listing.listStatus} fetch=${listing.fetchStatus ?? '-'}):[${listing.names.slice(0, 12).join(', ') || 'none'}]`);

  // (c) Sarvam REST endpoints for the job's result (cheap fallbacks).
  const REST_RESULT_PATHS = [
    `/speech-to-text/job/${jobId}/result`,
    `/speech-to-text/job/${jobId}/output`,
    `/speech-to-text/job/${jobId}/transcript`,
    `/speech-to-text/jobs/${jobId}/result`,
  ];
  const restAttempts: string[] = [];
  for (const path of REST_RESULT_PATHS) {
    const r = await sarvamFetch(path, { method: 'GET' });
    if (r.ok) {
      const out = await r.json().catch(() => null);
      const norm = out && tryNormalize(out, jobId);
      if (norm) return norm;
      if (out) rawDiag ||= `rest ${path}: ${snippet(out)}`;
    }
    restAttempts.push(`${path}→${r.status}`);
  }
  diag.push(`rest:[${restAttempts.join(' | ')}]`);

  // (d) Last resort: filename guessing at the blob output_storage_path.
  const inputBase = opts.filename.replace(/\.[^.]+$/, '');
  const OUTPUT_FILENAME_VARIANTS = Array.from(new Set([
    replaceExt(opts.filename, 'json'), `${opts.filename}.json`,
    `${inputBase}.result.json`, `${inputBase}.transcript.json`,
    'transcript.json', 'output.json', 'result.json', `${jobId}.json`, `${jobId}`,
  ]));
  const outputAttempts: string[] = [];
  for (const filename of OUTPUT_FILENAME_VARIANTS) {
    const r = await fetch(joinBlob(outputPath, filename));
    if (r.ok) {
      const out = await r.json().catch(() => null);
      const norm = out && tryNormalize(out, jobId);
      if (norm) return norm;
      if (out) rawDiag ||= `blob ${filename}: ${snippet(out)}`;
    }
    outputAttempts.push(`${filename}→${r.status}`);
  }
  diag.push(`blob:[${outputAttempts.join(' | ')}]`);

  // Nothing yielded a usable transcript. If we DID fetch a JSON payload, lead
  // with its raw shape — that's the thing that pinpoints the parser fix.
  // Otherwise report the fetch attempts + completion body.
  if (rawDiag) {
    throw new Error(`Sarvam returned no transcript we could parse — raw shape: ${rawDiag}`);
  }
  const bodySnippet = (lastBody || '').slice(0, 400).replace(/\s+/g, ' ');
  throw new Error(`Sarvam output fetch failed. ${diag.join(' | ')} | completion_body='${bodySnippet}'`);
}

/**
 * Discover Sarvam's real output by LISTING the Azure blob "directory" the batch
 * job writes to, instead of guessing filenames. Returns EVERY plausible output
 * blob parsed (JSON, or plain-text wrapped as { transcript }), because a job may
 * write a manifest/status JSON next to the transcript JSON and we must try each.
 * `output_storage_path` is an Azure SAS URL pointing at the job's output prefix;
 * we list that prefix (`comp=list`) and fetch each candidate with the same SAS.
 */
async function fetchAzureOutputByListing(
  outputPath: string,
): Promise<{ candidates: { name: string; json: any }[]; names: string[]; listStatus: number; fetchStatus?: number }> {
  const qIdx = outputPath.indexOf('?');
  const beforeQ = qIdx >= 0 ? outputPath.slice(0, qIdx) : outputPath;
  const sas = qIdx >= 0 ? outputPath.slice(qIdx + 1) : '';
  let origin = '', container = '', prefix = '';
  try {
    const u = new URL(beforeQ);
    origin = u.origin;
    const segs = u.pathname.replace(/^\//, '').split('/');
    container = segs.shift() || '';
    prefix = segs.join('/');
  } catch {
    return { candidates: [], names: [], listStatus: 0 };
  }
  const listUrl = `${origin}/${container}?restype=container&comp=list&prefix=${encodeURIComponent(prefix)}${sas ? '&' + sas : ''}`;
  let listRes: Response;
  try { listRes = await fetch(listUrl); } catch { return { candidates: [], names: [], listStatus: -1 }; }
  const listStatus = listRes.status;
  if (!listRes.ok) return { candidates: [], names: [], listStatus };
  const xml = await listRes.text();
  const names = Array.from(xml.matchAll(/<Name>([^<]+)<\/Name>/g)).map((m) => m[1]);
  const audio = /\.(m4a|wav|mp3|aac|mp4|opus|ogg|flac)$/i;
  // JSON blobs first (most likely the transcript), then any other non-audio
  // blob (a plain-text transcript). Cap the fetches so a huge listing can't
  // stall the pipeline.
  const ordered = [
    ...names.filter((n) => /\.json$/i.test(n)),
    ...names.filter((n) => !/\.json$/i.test(n) && !audio.test(n)),
  ];
  const candidates: { name: string; json: any }[] = [];
  let fetchStatus: number | undefined;
  for (const name of ordered.slice(0, 6)) {
    const blobUrl = `${origin}/${container}/${name.split('/').map(encodeURIComponent).join('/')}${sas ? '?' + sas : ''}`;
    let r: Response;
    try { r = await fetch(blobUrl); } catch { continue; }
    fetchStatus = r.status;
    if (!r.ok) continue;
    const txt = await r.text().catch(() => '');
    if (!txt) continue;
    try { candidates.push({ name, json: JSON.parse(txt) }); }
    catch {
      // Not JSON — if it isn't XML/HTML, treat it as a plain-text transcript.
      if (!/^\s*</.test(txt)) candidates.push({ name, json: { transcript: txt } });
    }
  }
  return { candidates, names, listStatus, fetchStatus };
}

const TRANSCRIPT_KEY_RE = /^(transcript|full_transcript|text|transcription)$/i;
const LANG_KEY_RE = /^(language_code|language|lang|detected_language)$/i;
const WRAPPER_KEYS = ['output', 'result', 'results', 'data', 'outputs', 'response'];

/**
 * tryNormalize returns a normalized result ONLY if it carries a non-empty
 * transcript; otherwise null. Lets callers walk multiple candidate blobs and
 * accept the first that actually decodes to speech (never a manifest/empty).
 */
function tryNormalize(out: any, jobId: string): TranscriptResult | null {
  const norm = normalize(out, jobId);
  return norm.transcript.trim() ? norm : null;
}

/**
 * Map Sarvam's output JSON into our normalized contract. Sarvam's real batch
 * output shape has varied across jobs (top-level, nested under output/result/
 * data, wrapped in a single-element array, keyed by filename), so we DEEP-search
 * for the transcript string and the diarized entries rather than reading fixed
 * paths.
 */
function normalize(out: any, jobId: string): TranscriptResult {
  const language = deepFindLanguage(out);
  let transcript = deepFindTranscript(out);
  const rawEntries = deepFindEntries(out);
  const segments: DiarizedSegment[] = rawEntries
    .map((e: any) => ({
      speaker: e.speaker_id || e.speaker || e.speaker_label || 'SPEAKER',
      text: (typeof e.transcript === 'string' ? e.transcript : e.text) || '',
      start: numOrUndef(e.start_time_seconds ?? e.start ?? e.start_time),
      end: numOrUndef(e.end_time_seconds ?? e.end ?? e.end_time),
    }))
    .filter((s: DiarizedSegment) => s.text.trim());
  if (!transcript && segments.length) transcript = segments.map((s) => s.text).join(' ');
  if (!segments.length && transcript) segments.push({ speaker: 'SPEAKER', text: transcript });
  return { transcript: transcript || '', segments, language, jobId };
}

/** First non-empty string found under a transcript-ish key, at any depth. */
function deepFindTranscript(node: any, depth = 0): string {
  if (node == null || depth > 6) return '';
  if (Array.isArray(node)) {
    for (const el of node) {
      const t = deepFindTranscript(el, depth + 1);
      if (t) return t;
    }
    return '';
  }
  if (typeof node !== 'object') return '';
  // Direct transcript-ish string keys win.
  for (const k of Object.keys(node)) {
    if (TRANSCRIPT_KEY_RE.test(k) && typeof node[k] === 'string' && node[k].trim()) return node[k];
  }
  // Then likely wrappers first, then everything else.
  const order = [
    ...WRAPPER_KEYS.filter((k) => k in node),
    ...Object.keys(node).filter((k) => !WRAPPER_KEYS.includes(k)),
  ];
  for (const k of order) {
    const t = deepFindTranscript(node[k], depth + 1);
    if (t) return t;
  }
  return '';
}

/** First diarized-entries array found at any depth. */
function deepFindEntries(node: any, depth = 0): any[] {
  if (node == null || depth > 6) return [];
  if (Array.isArray(node)) {
    if (node.length && node.every((e: any) =>
      e && typeof e === 'object' && !Array.isArray(e) &&
      (e.speaker !== undefined || e.speaker_id !== undefined || e.speaker_label !== undefined) &&
      (typeof e.transcript === 'string' || typeof e.text === 'string'))) {
      return node;
    }
    for (const el of node) {
      const r = deepFindEntries(el, depth + 1);
      if (r.length) return r;
    }
    return [];
  }
  if (typeof node !== 'object') return [];
  // Common wrapper: { diarized_transcript: { entries: [...] } | [...] }.
  const dt = node.diarized_transcript;
  if (dt) {
    if (Array.isArray(dt)) { const r = deepFindEntries(dt, depth + 1); if (r.length) return r; }
    else if (Array.isArray(dt.entries)) { const r = deepFindEntries(dt.entries, depth + 1); if (r.length) return r; }
  }
  for (const k of Object.keys(node)) {
    const r = deepFindEntries(node[k], depth + 1);
    if (r.length) return r;
  }
  return [];
}

/** First language-code string found at any depth. */
function deepFindLanguage(node: any, depth = 0): string | null {
  if (node == null || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const el of node) { const l = deepFindLanguage(el, depth + 1); if (l) return l; }
    return null;
  }
  if (typeof node !== 'object') return null;
  for (const k of Object.keys(node)) {
    if (LANG_KEY_RE.test(k) && typeof node[k] === 'string' && node[k].trim()) return node[k];
  }
  for (const k of Object.keys(node)) {
    const l = deepFindLanguage(node[k], depth + 1);
    if (l) return l;
  }
  return null;
}

/** Compact one-line JSON snippet for diagnostics (fail() keeps up to 2000 ch). */
function snippet(obj: any): string {
  try { return JSON.stringify(obj).slice(0, 1200).replace(/\s+/g, ' '); }
  catch { return String(obj).slice(0, 1200); }
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
