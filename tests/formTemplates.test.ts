/**
 * GET /forms/templates is what the mobile apps use to list the forms a rep can fill in.
 * iOS sends ?is_active=true (published only); Android sends no filter at all, so it used to be
 * offered every form — including ones an admin had archived. An archived (retired) form must
 * not be offered unless a caller asks for non-published forms explicitly.
 */
import { createSupabaseMock } from './helpers/supabaseMock';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock: make } = require('./helpers/supabaseMock');
  const m = make();
  return { __mock: m, supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('../src/lib/supabase') as { __mock: ReturnType<typeof createSupabaseMock> };
import { getTemplates } from '../src/controllers/forms.controller';

const USER = { id: '33333333-3333-3333-3333-333333333333', org_id: '00000000-0000-0000-0000-0000000000aa', role: 'field_executive' };

async function listTemplates(query: Record<string, string>) {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await (getTemplates as any)({ user: USER, query }, res, jest.fn());
  return res;
}

const statusFilters = () =>
  __mock.chainsFor('builder_forms')[0].ops
    .filter((o) => (o.method === 'eq' || o.method === 'neq') && o.args[0] === 'status')
    .map((o) => `${o.method}:${o.args[1]}`);

beforeEach(() => {
  __mock.reset();
  __mock.setDefault('builder_forms', { data: [] });
});

describe('GET /forms/templates', () => {
  it('leaves archived forms out when no is_active filter is sent (the Android app)', async () => {
    await listTemplates({});
    expect(statusFilters()).toEqual(['neq:archived']);
  });

  it('is_active=true still means published only (the iOS app)', async () => {
    await listTemplates({ is_active: 'true' });
    expect(statusFilters()).toEqual(['eq:published']);
  });

  it('is_active=false still returns the non-published forms, archived included, when asked for', async () => {
    await listTemplates({ is_active: 'false' });
    expect(statusFilters()).toEqual(['neq:published']);
  });
});

/**
 * The Android/iOS shape built by getTemplates used to drop the builder's per-question `validation`
 * (a rating's "Max Stars" = validation.max, min/max length, …). It is now passed through — additively.
 */
describe('GET /forms/templates — per-question validation', () => {
  const question = (over: Record<string, unknown>) => ({
    id: 'q-x',
    label: 'Q',
    qtype: 'text',
    q_order: 1,
    is_required: false,
    options: null,
    ...over,
  });

  const formWith = (questions: unknown[]) => ({
    id: 'f-1',
    title: 'Customer Feedback',
    description: null,
    activity_id: null,
    builder_questions: questions,
  });

  // asyncHandler does not hand its promise back, so wait for the response itself (or an error to `next`).
  function fields(): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn((body) => resolve(body.data[0].form_fields)) };
      (getTemplates as any)({ user: USER, query: {} }, res, (err: unknown) => reject(err ?? new Error('next() called')));
    });
  }

  it('passes validation (e.g. a rating\'s Max Stars) through to each form_field', async () => {
    __mock.setDefault('builder_forms', {
      data: [
        formWith([
          question({ id: 'q-rating', label: 'Rate us', qtype: 'rating', q_order: 1, validation: { max: 7 } }),
          question({ id: 'q-text', label: 'Comment', qtype: 'text', q_order: 2, validation: { minLength: 3, maxLength: 120 } }),
        ]),
      ],
    });

    const f = await fields();

    expect(f.find((x) => x.id === 'q-rating').validation).toEqual({ max: 7 });
    expect(f.find((x) => x.id === 'q-text').validation).toEqual({ minLength: 3, maxLength: 120 });
  });

  it('is an empty object when the question has no validation (null or missing)', async () => {
    __mock.setDefault('builder_forms', {
      data: [
        formWith([
          question({ id: 'q-null', q_order: 1, validation: null }),
          question({ id: 'q-missing', q_order: 2 }),
        ]),
      ],
    });

    const f = await fields();

    expect(f.find((x) => x.id === 'q-null').validation).toEqual({});
    expect(f.find((x) => x.id === 'q-missing').validation).toEqual({});
  });

  it('only ADDS the key: every field the apps already read is unchanged', async () => {
    __mock.setDefault('builder_forms', {
      data: [
        formWith([
          question({
            id: 'q-1',
            label: 'Rate us',
            qtype: 'rating',
            placeholder: 'tap',
            helper_text: 'help',
            is_required: true,
            q_order: 3,
            keyboard_type: 'number',
            image_count: 2,
            camera_only: true,
            is_consent: false,
            depends_on_id: 'q-0',
            depends_on_value: 'yes',
            options: ['a', 'b'],
            validation: { max: 5 },
          }),
        ]),
      ],
    });

    const f = await fields();

    expect(f).toEqual([
      {
        id: 'q-1',
        label: 'Rate us',
        field_key: 'q-1',
        field_type: 'rating',
        placeholder: 'tap',
        help_text: 'help',
        is_required: true,
        sort_order: 3,
        keyboard_type: 'number',
        image_count: 2,
        camera_only: true,
        is_consent: false,
        depends_on_id: 'q-0',
        depends_on_value: 'yes',
        options: ['a', 'b'],
        validation: { max: 5 },
      },
    ]);
  });
});
