import request from 'supertest';
import { shapeAttendanceHistory } from '../src/lib/attendanceHistory';

jest.mock('../src/lib/supabase', () => {
  const { createSupabaseMock } = require('./helpers/supabaseMock');
  const m = createSupabaseMock();
  return { supabaseAdmin: m.client, supabase: m.client, getUserClient: () => m.client };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
import app from '../src/app';

describe('shapeAttendanceHistory', () => {
  const rows = [{ date: '2026-10-06' }, { date: '2026-10-05' }];

  it('exposes the Android shape (items/total/page/limit/totalPages)', () => {
    const r = shapeAttendanceHistory(rows, 41, 2, 30);
    expect(r.items).toEqual(rows);
    expect(r).toMatchObject({ total: 41, page: 2, limit: 30, totalPages: 2 });
  });

  it('keeps the previous nested shape (data + pagination) for existing readers', () => {
    const r = shapeAttendanceHistory(rows, 41, 2, 30);
    expect(r.data).toEqual(rows);
    expect(r.pagination).toEqual({ page: 2, limit: 30, total: 41, totalPages: 2 });
  });

  it('handles an empty history', () => {
    expect(shapeAttendanceHistory([], 0, 1, 30)).toMatchObject({ items: [], total: 0, totalPages: 0 });
  });
});

describe('GET /api/v1/attendance/history', () => {
  it('returns items[] (what the Android app decodes) alongside the legacy data/pagination', async () => {
    const res = await request(app).get('/api/v1/attendance/history').set('Authorization', 'Bearer demo-token-jwt-placeholder');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    expect(res.body.data.items).toEqual(res.body.data.data);
    expect(res.body.data.items[0]).toHaveProperty('date');
  });
});
