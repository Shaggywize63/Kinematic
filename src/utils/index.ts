import { Response, NextFunction, RequestHandler } from 'express'
export * from './asyncHandler';

// ── Standard application error ──
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code?: string
  ) {
    super(message)
    this.name = 'AppError'
    Error.captureStackTrace(this, this.constructor)
  }
}

// ── Paginate helper ──
export interface PaginationParams {
  page: number
  limit: number
  offset: number
}

export function getPagination(
  page = 1,
  limit = 20
): PaginationParams {
  const safePage  = Math.max(1, page)
  const safeLimit = Math.min(1000, Math.max(1, limit))
  return {
    page: safePage,
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
  }
}

// ── Success responses ──

/**
 * Standard success response.
 * code 4 is used to bypass build breaks where controllers call with 4 arguments.
 */
export function sendSuccess(
  res: Response,
  data: any,
  message = 'Success',
  statusCode = 200
) {
  res.status(statusCode).json({ success: true, message, data });
}

export function ok<T>(res: Response, data: T, message?: string) {
  res.status(200).json({ success: true, data, ...(message && { message }) });
}

export function created<T>(res: Response, data: T, message?: string) {
  res.status(201).json({ success: true, data, ...(message && { message }) });
}

export function badRequest(res: Response, error: string, details?: unknown) {
  res.status(400).json({ success: false, error, ...(details && { details }) });
}

export function notFound(res: Response, error = 'Not found') {
  res.status(404).json({ success: false, error });
}

export function forbidden(res: Response, error = 'Forbidden') {
  res.status(403).json({ success: false, error });
}

export function conflict(res: Response, error: string) {
  res.status(409).json({ success: false, error });
}

export function sendPaginated(
  res: Response,
  data: any[],
  total: number,
  page: number,
  limit: number
) {
  res.status(200).json({
    success: true,
    data,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  });
}

export const isUUID = (id: any): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id));

// ── TIMEZONE (IST) UTILS ──

export function toIST(date: Date = new Date()): Date {
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  return new Date(utc + (3600000 * 5.5));
}

export function isoDate(d: Date): string {
  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function dbToday(): string {
  return isoDate(toIST());
}

export function todayDate(): string {
  const ist = toIST();
  const d = ist.getDate().toString().padStart(2, '0');
  const m = (ist.getMonth() + 1).toString().padStart(2, '0');
  const y = ist.getFullYear();
  return `${d}--${m}--${y}`;
}

export function parseAppDate(appDate: string | null): string {
  if (!appDate) return dbToday();
  const raw = appDate.trim();
  if (raw.match(/^\d{4}-\d{2}-\d{2}/)) return raw.substring(0, 10);
  const sep = raw.includes('--') ? '--' : (raw.includes('/') ? '/' : (raw.includes('-') ? '-' : null));
  if (sep) {
    const parts = raw.split(sep);
    if (parts.length === 3) {
      let p1 = parseInt(parts[0]), p2 = parseInt(parts[1]), y = parseInt(parts[2]);
      if (y < 100) y += 2000;
      let m, d;
      if (p1 > 12) { d = p1; m = p2; }
      else if (p2 > 12) { m = p1; d = p2; }
      else { if (sep === '/') { m = p1; d = p2; } else { d = p1; m = p2; } }
      return `${y}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
    }
  }
  return dbToday();
}

export function getISTSearchRange(istDate: string) {
  const [y, m, day] = istDate.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, day - 1, 18, 30, 0)).toISOString();
  const end = new Date(Date.UTC(y, m - 1, day, 18, 29, 59)).toISOString();
  return { start, end };
}

export function formatAppDate(date: any): string {
  if (!date) return '';
  const d = new Date(date);
  const dd = d.getDate().toString().padStart(2, '0');
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}--${mm}--${yyyy}`;
}
// Add clientId helper used in some controllers
export function clientId(req: Request): string | null {
  return (req as any).user?.client_id || null;
}
