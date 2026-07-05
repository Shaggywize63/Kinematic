/**
 * Audio helpers for the conversation-intel pipeline.
 *
 * Mobile clients record Apple AAC in an `.m4a` container. Sarvam's batch STT
 * "supports" m4a, but in practice it has repeatedly returned an EMPTY transcript
 * for these files (job reports Success, `transcript: ""`, `language_code: null`)
 * — a classic sign the decoder isn't extracting audio from Apple's container.
 * So before handing audio to Sarvam we transcode it to 16 kHz mono 16-bit PCM
 * WAV: WAV PCM is the most reliably decoded input and 16 kHz is Sarvam's
 * recommended rate.
 *
 * The ffmpeg binary is bundled by `@ffmpeg-installer/ffmpeg` (a platform
 * optional-dependency — no system package, no build-time download). The lookup
 * is LAZY + guarded so a missing/broken binary degrades to "no transcode"
 * instead of crashing the whole service at import time; the caller then falls
 * back to uploading the original bytes.
 */
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

let _ffmpegPath: string | null | undefined;
function ffmpegPath(): string | null {
  if (_ffmpegPath !== undefined) return _ffmpegPath;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _ffmpegPath = (require('@ffmpeg-installer/ffmpeg').path as string) || null;
  } catch {
    _ffmpegPath = null;
  }
  return _ffmpegPath;
}

export interface TranscodeResult {
  wav: Buffer;
  peak: number;        // 0..1 peak amplitude — ~0 means (near-)silent audio
  rms: number;         // 0..1 rms amplitude
  durationSec: number; // decoded duration
}

function runFfmpeg(bin: string, args: string[], timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr?.on('data', (d) => { if (err.length < 2000) err += d.toString(); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${err.slice(-300).replace(/\s+/g, ' ')}`));
    });
  });
}

/**
 * Transcode an arbitrary audio buffer to 16 kHz mono PCM WAV and measure its
 * loudness. Throws if ffmpeg is unavailable or the input can't be decoded — the
 * caller treats that as "upload the original unchanged".
 */
export async function transcodeToWav16kMono(input: Buffer, srcName: string): Promise<TranscodeResult> {
  const bin = ffmpegPath();
  if (!bin) throw new Error('ffmpeg unavailable');
  const ext = (srcName.match(/\.([a-z0-9]+)$/i)?.[1] || 'm4a').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'm4a';
  const stamp = `${process.pid}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const inFile = path.join(os.tmpdir(), `sarvam-${stamp}.${ext}`);
  const outFile = path.join(os.tmpdir(), `sarvam-${stamp}.wav`);
  try {
    await fs.writeFile(inFile, input);
    await runFfmpeg(bin, ['-y', '-hide_banner', '-i', inFile, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', outFile]);
    const wav = await fs.readFile(outFile);
    if (wav.length <= 44) throw new Error('ffmpeg produced empty wav');
    const { peak, rms, samples } = pcmStats(wav);
    return { wav, peak, rms, durationSec: samples / 16000 };
  } finally {
    fs.unlink(inFile).catch(() => {});
    fs.unlink(outFile).catch(() => {});
  }
}

/** Peak + RMS (each 0..1) over the 16-bit PCM body of a WAV buffer. */
function pcmStats(wav: Buffer): { peak: number; rms: number; samples: number } {
  // Locate the 'data' chunk; fall back to the canonical 44-byte header offset.
  let off = 44;
  const idx = wav.indexOf('data', 12, 'ascii');
  if (idx >= 0 && idx + 8 <= wav.length) off = idx + 8;
  let peak = 0, sumSq = 0, n = 0;
  for (let i = off; i + 1 < wav.length; i += 2) {
    const s = wav.readInt16LE(i);
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    sumSq += s * s;
    n++;
  }
  const rms = n ? Math.sqrt(sumSq / n) : 0;
  return { peak: peak / 32768, rms: rms / 32768, samples: n };
}
