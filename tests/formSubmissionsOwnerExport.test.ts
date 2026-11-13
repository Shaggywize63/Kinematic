/**
 * Field-executive form submissions: own-submission list/read/edit scoping, the
 * form reference number (`ref_no`) surfaced on reads, the per-submission export
 * endpoint's shape + owner gating, and the resilient photo-answer handling
 * (array / `photos` / `[{url}]` / image-field `value` all land in `photo_url`).
 *
 * Signing is mocked (no live storage): `signStoredUrlsForUser` returns a
 * deterministic `SIGNED(<url>)` so the export/read photo wiring is assertable.
 */
import express from 'express';
import request from 'supertest';
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
jest.mock('../src/middleware/auth', () => ({
  ...jest.requireActual('../src/middleware/auth'),
  requireAuth: (req: any, _res: any, next: any) => { req.user = { ...(global as any).__testUser }; next(); },
}));
// Deterministic signing — never dial real storage.
jest.mock('../src/controllers/media.controller', () => ({
  ...jest.requireActual('../src/controllers/media.controller'),
  signStoredUrlsForUser: jest.fn(async (_u: any, urls: Array<string | null | undefined>) =>
    (urls || [])
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .map((u) => ({ url: u, signed: `SIGNED(${u})` }))),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const formsRouter = require('../src/routes/forms.routes').default as express.Router;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { errorHandler } = require('../src/middleware/errorHandler') as { errorHandler: express.ErrorRequestHandler };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizePhotoAnswer, splitPhotoUrls } = require('../src/controllers/forms.controller') as {
  normalizePhotoAnswer: (r: any, isImg?: boolean) => string | null;
  splitPhotoUrls: (s: unknown) => string[];
};

const ORG = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000bb';
const REP_A = '11111111-1111-4111-8111-111111111111';
const REP_B = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const FORM = '44444444-4444-4444-8444-444444444444';
const SUB = '55555555-5555-4555-8555-555555555555';
const Q = '66666666-6666-4666-8666-666666666666';

const repA = { id: REP_A, org_id: ORG, role: 'sales_executive', email: 'a@t.test' };
const repB = { id: REP_B, org_id: ORG, role: 'field_executive', email: 'b@t.test' };
const admin = { id: ADMIN, org_id: ORG, role: 'admin', email: 'adm@t.test' };

const app = express();
app.use(express.json());
app.use('/forms', formsRouter);
app.use(errorHandler);

const asUser = (u: any) => { (global as any).__testUser = { ...u }; };

beforeEach(() => {
  __mock.reset();
  asUser(repA);
});

// ---------------------------------------------------------------------------
// normalizePhotoAnswer — the resilient photo-answer parsing (pure unit tests).
// ---------------------------------------------------------------------------
describe('normalizePhotoAnswer', () => {
  it('keeps a single string and a legacy comma-joined string', () => {
    expect(normalizePhotoAnswer({ photo: 'u1' })).toBe('u1');
    expect(normalizePhotoAnswer({ photo: 'u1,u2' })).toBe('u1,u2');
  });
  it('rescues an ARRAY of urls (the dropped-photos root cause)', () => {
    expect(normalizePhotoAnswer({ photo: ['u1', 'u2'] })).toBe('u1,u2');
  });
  it('rescues the `photos` key and `[{url}]` / `[{path}]` object shapes', () => {
    expect(normalizePhotoAnswer({ photos: ['u1'] })).toBe('u1');
    expect(normalizePhotoAnswer({ photo: [{ url: 'u1' }, { path: 'u2' }] })).toBe('u1,u2');
  });
  it('de-dupes and trims, and returns null for an empty answer', () => {
    expect(normalizePhotoAnswer({ photo: [' u1 ', 'u1'] })).toBe('u1');
    expect(normalizePhotoAnswer({})).toBeNull();
    expect(normalizePhotoAnswer({ photo: [] })).toBeNull();
  });
  it('only falls back to `value` for image-typed fields', () => {
    expect(normalizePhotoAnswer({ value: 'u1' }, true)).toBe('u1');
    expect(normalizePhotoAnswer({ value: 'u1' }, false)).toBeNull();
  });
});

describe('splitPhotoUrls', () => {
  it('splits a stored comma-joined photo_url and tolerates null', () => {
    expect(splitPhotoUrls('u1,u2')).toEqual(['u1', 'u2']);
    expect(splitPhotoUrls(' u1 , u2 ')).toEqual(['u1', 'u2']);
    expect(splitPhotoUrls(null)).toEqual([]);
    expect(splitPhotoUrls('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /forms/submissions — list of the caller's OWN submissions.
// ---------------------------------------------------------------------------
describe('GET /forms/submissions (own list)', () => {
  it('scopes to the caller via user_id and surfaces ref_no', async () => {
    __mock.queue('form_submissions', {
      data: [{ id: SUB, user_id: REP_A, ref_no: 'SRPR2627-7', submitted_at: '2026-11-13T05:00:00.000Z', builder_forms: { title: 'Gold Scheme' } }],
      count: 1,
    });
    const res = await request(app).get('/forms/submissions');
    expect(res.status).toBe(200);
    expect(res.body.data.data[0].ref_no).toBe('SRPR2627-7');
    // Owner-scoped: the query filters user_id to the caller, never another rep.
    expect(__mock.chainsFor('form_submissions')[0].eqs.user_id).toBe(REP_A);
  });
});

// ---------------------------------------------------------------------------
// GET /forms/submissions/:id/export — owner-or-admin, structured + signed.
// ---------------------------------------------------------------------------
describe('GET /forms/submissions/:id/export', () => {
  const queueSub = (overrides: Record<string, unknown> = {}) =>
    __mock.queue('form_submissions', {
      data: {
        id: SUB, user_id: REP_A, org_id: ORG, template_id: FORM, ref_no: 'SRPR2627-7',
        submitted_at: '2026-11-13T05:00:00.000Z', outlet_name: 'Acme Store', address: 'MG Road',
        builder_forms: { title: 'Gold Scheme' }, activities: { name: 'Store Visit' },
        crm_accounts: { name: 'Acme Ltd' }, users: { id: REP_A, name: 'Rep A', employee_id: 'E1' },
        ...overrides,
      },
    });

  it('400s on a non-UUID id', async () => {
    const res = await request(app).get('/forms/submissions/not-a-uuid/export');
    expect(res.status).toBe(400);
  });

  it('exports the owner’s submission with ref_no, title, submitter and SIGNED photo urls', async () => {
    queueSub();
    __mock.queue('form_responses', {
      data: [{ field_id: Q, value_text: 'Nitrile', photo_url: 'u1,u2', builder_questions: { label: 'Gloves', qtype: 'photo', q_order: 1 } }],
    });
    const res = await request(app).get(`/forms/submissions/${SUB}/export`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.ref_no).toBe('SRPR2627-7');
    expect(d.form_title).toBe('Gold Scheme');
    expect(d.submitter).toEqual({ id: REP_A, name: 'Rep A', employee_id: 'E1' });
    expect(d.submitted_at).toBe('2026-11-13T05:00:00.000Z');
    expect(d.answers).toHaveLength(1);
    expect(d.answers[0].label).toBe('Gloves');
    expect(d.answers[0].photos).toEqual([
      { url: 'u1', signed: 'SIGNED(u1)' }, { url: 'u2', signed: 'SIGNED(u2)' },
    ]);
    expect(d.photos).toEqual([
      { url: 'u1', signed: 'SIGNED(u1)' }, { url: 'u2', signed: 'SIGNED(u2)' },
    ]);
    expect(d.signed_url_ttl_seconds).toBe(7 * 24 * 60 * 60);
  });

  it('forbids a different rep in the same org (403)', async () => {
    asUser(repB);
    queueSub();
    const res = await request(app).get(`/forms/submissions/${SUB}/export`);
    expect(res.status).toBe(403);
  });

  it('lets a tenant admin export any rep’s submission (200)', async () => {
    asUser(admin);
    queueSub();
    __mock.queue('form_responses', { data: [] });
    const res = await request(app).get(`/forms/submissions/${SUB}/export`);
    expect(res.status).toBe(200);
    expect(res.body.data.ref_no).toBe('SRPR2627-7');
  });

  it('404s a submission from another org (no cross-tenant read)', async () => {
    asUser(repB);
    queueSub({ user_id: ADMIN, org_id: OTHER_ORG });
    const res = await request(app).get(`/forms/submissions/${SUB}/export`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /forms/submissions/:id — owner-or-admin edit; photo answers resilient.
// ---------------------------------------------------------------------------
describe('PATCH /forms/submissions/:id (own edit)', () => {
  it('forbids a different rep editing another rep’s submission (403)', async () => {
    asUser(repB);
    __mock.queue('form_submissions', { data: { id: SUB, user_id: REP_A, org_id: ORG } });
    const res = await request(app).patch(`/forms/submissions/${SUB}`).send({ outlet_name: 'Hacked' });
    expect(res.status).toBe(403);
  });

  it('lets the owner edit and normalises a PHOTO ARRAY answer into photo_url', async () => {
    asUser(repA);
    // 1) load the submission (owner).
    __mock.queue('form_submissions', { data: { id: SUB, user_id: REP_A, org_id: ORG, outlet_name: 'Old', address: 'Addr' } });
    // 2) existing form_responses (none → insert path).
    __mock.queue('form_responses', { data: [] });
    // 3) builder_questions labels/types — Q is an image field.
    __mock.queue('builder_questions', { data: [{ id: Q, label: 'Shelf Photo', qtype: 'photo' }] });
    // 4) the insert of the new response.
    __mock.queue('form_responses', { data: {} });
    // 5) the form_submissions update.
    __mock.queue('form_submissions', { data: {} });
    // 6) the history insert.
    __mock.queue('form_submission_history', { data: {} });
    // 7) fresh submission + 8) fresh responses.
    __mock.queue('form_submissions', { data: { id: SUB, user_id: REP_A, org_id: ORG, builder_forms: { title: 'Gold Scheme' } } });
    __mock.queue('form_responses', { data: [{ field_id: Q, photo_url: 'u1,u2' }] });

    const res = await request(app)
      .patch(`/forms/submissions/${SUB}`)
      .send({ responses: [{ field_id: Q, photo: ['u1', 'u2'] }] });

    expect(res.status).toBe(200);
    expect(res.body.data.changed).toBe(1);
    // The inserted form_responses row stored the array as a comma-joined photo_url.
    const insertChain = __mock.chainsFor('form_responses').find((c) => c.ops.some((o) => o.method === 'insert'));
    const insertArg = insertChain!.ops.find((o) => o.method === 'insert')!.args[0] as any;
    expect(insertArg.photo_url).toBe('u1,u2');
  });
});
