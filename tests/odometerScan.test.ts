/**
 * POST /expenses/receipts?scan=odometer — reads the odometer instead of a receipt.
 *
 *   - the pure reply parsing (what the model returns -> a safe whole-km reading);
 *   - the Anthropic call (prompt, model override, failure);
 *   - uploadReceipt in each mode: odometer / receipt (default) / none — a failed OCR never loses the upload;
 *   - the real router honouring ?scan=odometer | 0 | (default).
 */
import express from 'express';
import request from 'supertest';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  const bucket = {
    upload: jest.fn().mockResolvedValue({ error: null }),
    getPublicUrl: jest.fn((p: string) => ({ data: { publicUrl: `https://x.test/storage/v1/object/public/kinematic-receipts/${p}` } })),
    createSignedUrl: jest.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.test/o' }, error: null }),
  };
  (m.client as any).storage = {
    getBucket: jest.fn().mockResolvedValue({ data: { id: 'kinematic-receipts' } }),
    createBucket: jest.fn().mockResolvedValue({ error: null }),
    from: jest.fn(() => bucket),
  };
  return { __mock: m, __bucket: bucket, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/services/ai.service', () => ({
  AIService: { getFunctionalKey: jest.fn().mockResolvedValue('test-key'), callKiniAI: jest.fn() },
}));
jest.mock('../src/services/expenses/receiptScan.service', () => ({
  ...jest.requireActual('../src/services/expenses/receiptScan.service'),
  scanReceipt: jest.fn(),
}));
jest.mock('../src/services/expenses/odometerScan.service', () => ({
  ...jest.requireActual('../src/services/expenses/odometerScan.service'),
  scanOdometer: jest.fn(),
}));

import { toOdometerKm, parseOdometerReply, MAX_ODOMETER_KM } from '../src/services/expenses/odometerScan.service';
import * as odometerScan from '../src/services/expenses/odometerScan.service';
import * as receiptScan from '../src/services/expenses/receiptScan.service';
import { uploadReceipt } from '../src/services/expenses/receipts.service';
import expensesRouter from '../src/routes/expenses.routes';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const REP = '11111111-1111-1111-1111-111111111111';
const actor = { id: REP, org_id: ORG, client_id: null, role: 'executive' } as any;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 1)]);

const scanOdometer = odometerScan.scanOdometer as unknown as jest.Mock;
const scanReceipt = receiptScan.scanReceipt as unknown as jest.Mock;
const realScan = jest.requireActual('../src/services/expenses/odometerScan.service').scanOdometer as typeof odometerScan.scanOdometer;

describe('a model value -> whole kilometres', () => {
  it('takes plain numbers', () => {
    expect(toOdometerKm(45210)).toBe(45210);
    expect(toOdometerKm(0)).toBe(0);
  });
  it('strips separators, units and spaces', () => {
    expect(toOdometerKm('12,345')).toBe(12345);
    expect(toOdometerKm('12 345 km')).toBe(12345);
    expect(toOdometerKm(' 045210 ')).toBe(45210);
    expect(toOdometerKm("1'23'456")).toBe(123456);
    expect(toOdometerKm('12345KMS')).toBe(12345);
  });
  it('drops a tenths digit instead of reading it as part of the number', () => {
    expect(toOdometerKm(12345.6)).toBe(12345);
    expect(toOdometerKm('12345.6')).toBe(12345);
  });
  it('is bounded to 0..10,000,000', () => {
    expect(toOdometerKm(MAX_ODOMETER_KM)).toBe(MAX_ODOMETER_KM);
    expect(toOdometerKm(MAX_ODOMETER_KM + 1)).toBeNull();
    expect(toOdometerKm(-1)).toBeNull();
    expect(toOdometerKm('99999999')).toBeNull();
  });
  it('gives null for anything that is not a reading', () => {
    for (const bad of [null, undefined, NaN, Infinity, 'abc', '', '12a45', '1.234.567', {}, [], true]) {
      expect({ bad, out: toOdometerKm(bad) }).toEqual({ bad, out: null });
    }
  });
});

describe('the model reply', () => {
  it('parses the strict shape', () => {
    expect(parseOdometerReply('{"reading": 45210, "confidence": "high"}')).toEqual({ reading: 45210, confidence: 'high' });
  });
  it('copes with a markdown fence or a sentence around the JSON', () => {
    expect(parseOdometerReply('```json\n{"reading": 700, "confidence": "medium"}\n```')).toEqual({ reading: 700, confidence: 'medium' });
    expect(parseOdometerReply('Here you go: {"reading": 31, "confidence": "low"} done')).toEqual({ reading: 31, confidence: 'low' });
  });
  it('normalises the confidence, and drops one it does not know', () => {
    expect(parseOdometerReply('{"reading": 5, "confidence": " HIGH "}').confidence).toBe('high');
    expect(parseOdometerReply('{"reading": 5, "confidence": "certain"}')).toEqual({ reading: 5, confidence: null });
    expect(parseOdometerReply('{"reading": 5}')).toEqual({ reading: 5, confidence: null });
  });
  it('is empty when the model says it is unsure, and carries no confidence for no reading', () => {
    expect(parseOdometerReply('{"reading": null, "confidence": null}')).toEqual({ reading: null, confidence: null });
    expect(parseOdometerReply('{"reading": null, "confidence": "high"}')).toEqual({ reading: null, confidence: null });
    expect(parseOdometerReply('{"reading": "unreadable", "confidence": "low"}')).toEqual({ reading: null, confidence: null });
  });
  it('is empty for an out-of-range number', () => {
    expect(parseOdometerReply('{"reading": 123456789, "confidence": "high"}')).toEqual({ reading: null, confidence: null });
  });
  it('is empty for garbage, and never throws', () => {
    for (const bad of ['', 'no json here', '{not json}', '{', '}{', '[1,2,3]']) {
      expect({ bad, out: parseOdometerReply(bad) }).toEqual({ bad, out: { reading: null, confidence: null } });
    }
  });
});

describe('the Anthropic call', () => {
  const realFetch = global.fetch;
  const reply = (text: string, ok = true, status = 200) =>
    jest.fn().mockResolvedValue({ ok, status, json: async () => (ok ? { content: [{ text }] } : { error: { message: 'overloaded' } }) });
  afterEach(() => { global.fetch = realFetch; delete process.env.ODOMETER_SCAN_MODEL; delete process.env.RECEIPT_SCAN_MODEL; delete process.env.CARD_SCAN_MODEL; });

  it('sends the photo with a prompt that asks for the TOTAL odometer, and returns the parsed reading', async () => {
    const f = reply('{"reading": 45210, "confidence": "high"}');
    global.fetch = f as any;
    const out = await realScan('QUJD', 'image/jpeg');
    expect(out).toEqual({ reading: 45210, confidence: 'high' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('test-key');
    const body = JSON.parse(init.body);
    expect(body.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
    // the prompt must steer the model to the total-distance counter and away from every look-alike
    for (const word of [/TOTAL/, /ODO/, /trip/i, /clock/i, /fuel/i, /speed/i, /whole kilometres/, /null/, /JSON only/]) expect(body.system).toMatch(word);
  });

  it('uses ODOMETER_SCAN_MODEL, else the receipt model, else the default', async () => {
    const model = async () => {
      const f = reply('{"reading": 1, "confidence": "high"}');
      global.fetch = f as any;
      await realScan('QUJD');
      return JSON.parse(f.mock.calls[0][1].body).model;
    };
    expect(await model()).toBe('claude-haiku-4-5');
    process.env.RECEIPT_SCAN_MODEL = 'receipt-model';
    expect(await model()).toBe('receipt-model');
    process.env.ODOMETER_SCAN_MODEL = 'odo-model';
    expect(await model()).toBe('odo-model');
  });

  it('throws on an API error (the upload layer swallows it)', async () => {
    global.fetch = reply('', false, 529) as any;
    await expect(realScan('QUJD')).rejects.toMatchObject({ code: 'ODOMETER_SCAN_ERROR', statusCode: 529 });
  });

  it('returns an empty reading for a reply it cannot use', async () => {
    global.fetch = reply('I cannot tell') as any;
    expect(await realScan('QUJD')).toEqual({ reading: null, confidence: null });
  });
});

describe('uploadReceipt', () => {
  beforeEach(() => {
    scanOdometer.mockReset(); scanReceipt.mockReset();
    scanOdometer.mockResolvedValue({ reading: 45210, confidence: 'high' });
    scanReceipt.mockResolvedValue({ merchant: 'Shell', amount: 500 });
  });
  const file = (buffer: Buffer) => ({ buffer, mimetype: 'image/jpeg', originalname: 'o.jpg', size: buffer.length });

  it('odometer mode: reads the odometer, not a receipt, and says so in data.odometer (data.scan stays null)', async () => {
    const out: any = await uploadReceipt(actor, file(JPEG), { scan: 'odometer' });
    expect(scanOdometer).toHaveBeenCalledWith(JPEG.toString('base64'), 'image/jpeg');
    expect(scanReceipt).not.toHaveBeenCalled();
    expect(out.odometer).toEqual({ reading: 45210, confidence: 'high' });
    expect(out.scan).toBeNull();
    // the existing upload fields are all still there
    expect(out).toMatchObject({ bucket: 'kinematic-receipts', content_type: 'image/jpeg', size: JPEG.length, signed_url: 'https://signed.test/o' });
    expect(out.url).toMatch(new RegExp(`/kinematic-receipts/${ORG}/${REP}/.+\\.jpg$`));
    expect(out.path).toMatch(new RegExp(`^${ORG}/${REP}/`));
  });

  it('odometer mode: a failed OCR never loses the upload (reading null)', async () => {
    scanOdometer.mockRejectedValue(new Error('anthropic down'));
    const out: any = await uploadReceipt(actor, file(JPEG), { scan: 'odometer' });
    expect(out.odometer).toEqual({ reading: null, confidence: null });
    expect(out.scan).toBeNull();
    expect(out.url).toBeTruthy();
    expect(out.path).toBeTruthy();
  });

  it('odometer mode: a file that cannot be read by the model (PDF) is stored with an empty reading', async () => {
    const out: any = await uploadReceipt(actor, file(PDF), { scan: 'odometer' });
    expect(scanOdometer).not.toHaveBeenCalled();
    expect(out.odometer).toEqual({ reading: null, confidence: null });
    expect(out.content_type).toBe('application/pdf');
  });

  it('default mode is today\'s receipt scan, with no `odometer` key at all', async () => {
    const out: any = await uploadReceipt(actor, file(JPEG));
    expect(scanReceipt).toHaveBeenCalledTimes(1);
    expect(scanOdometer).not.toHaveBeenCalled();
    expect(out.scan).toEqual({ merchant: 'Shell', amount: 500 });
    expect('odometer' in out).toBe(false);
    expect(Object.keys(out).sort()).toEqual(['bucket', 'content_type', 'path', 'scan', 'signed_url', 'size', 'url']);
  });

  it('scan:true behaves as the default, scan:false stores only', async () => {
    expect(((await uploadReceipt(actor, file(JPEG), { scan: true })) as any).scan).toEqual({ merchant: 'Shell', amount: 500 });
    scanReceipt.mockClear();
    const out: any = await uploadReceipt(actor, file(JPEG), { scan: false });
    expect(scanReceipt).not.toHaveBeenCalled();
    expect(scanOdometer).not.toHaveBeenCalled();
    expect(out.scan).toBeNull();
    expect('odometer' in out).toBe(false);
  });

  it('a failed receipt OCR still behaves as before (scan null)', async () => {
    scanReceipt.mockRejectedValue(new Error('boom'));
    const out: any = await uploadReceipt(actor, file(JPEG));
    expect(out.scan).toBeNull();
    expect(out.url).toBeTruthy();
  });
});

describe('POST /expenses/receipts', () => {
  const app = express();
  app.use((req: any, _res, next) => { req.user = { id: REP, org_id: ORG, client_id: null, role: 'executive' }; next(); });
  app.use('/expenses', expensesRouter);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ success: false, error: err.message, code: err.code }));

  beforeEach(() => {
    scanOdometer.mockReset(); scanReceipt.mockReset();
    scanOdometer.mockResolvedValue({ reading: 120345, confidence: 'medium' });
    scanReceipt.mockResolvedValue({ merchant: 'Shell', amount: 500 });
  });
  const post = (qs: string) => request(app).post(`/expenses/receipts${qs}`).attach('file', JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });

  it('?scan=odometer returns data.odometer and a null data.scan', async () => {
    const res = await post('?scan=odometer');
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.odometer).toEqual({ reading: 120345, confidence: 'medium' });
    expect(res.body.data.scan).toBeNull();
    expect(res.body.data.url).toBeTruthy();
    expect(scanReceipt).not.toHaveBeenCalled();
  });

  it('is case-insensitive about the mode', async () => {
    const res = await post('?scan=Odometer');
    expect(res.body.data.odometer.reading).toBe(120345);
  });

  it('?scan=0 stores the photo only', async () => {
    const res = await post('?scan=0');
    expect(res.status).toBe(201);
    expect(res.body.data.scan).toBeNull();
    expect('odometer' in res.body.data).toBe(false);
    expect(scanReceipt).not.toHaveBeenCalled();
    expect(scanOdometer).not.toHaveBeenCalled();
  });

  it('with no ?scan it is the receipt scan, exactly as before', async () => {
    const res = await post('');
    expect(res.status).toBe(201);
    expect(res.body.data.scan).toEqual({ merchant: 'Shell', amount: 500 });
    expect('odometer' in res.body.data).toBe(false);
    expect(scanOdometer).not.toHaveBeenCalled();
  });

  it('?scan=1 and an unknown mode are also the receipt scan', async () => {
    for (const qs of ['?scan=1', '?scan=receipt']) {
      scanReceipt.mockClear();
      const res = await post(qs);
      expect({ qs, scan: res.body.data.scan }).toEqual({ qs, scan: { merchant: 'Shell', amount: 500 } });
    }
  });

  it('still needs a file', async () => {
    const res = await request(app).post('/expenses/receipts?scan=odometer');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_FILE');
  });

  it('a failed OCR still answers 201 with the upload and an empty reading', async () => {
    scanOdometer.mockRejectedValue(new Error('down'));
    const res = await post('?scan=odometer');
    expect(res.status).toBe(201);
    expect(res.body.data.odometer).toEqual({ reading: null, confidence: null });
    expect(res.body.data.url).toBeTruthy();
  });
});
