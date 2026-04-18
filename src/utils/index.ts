import { Response, NextFunction, RequestHandler, Request } from 'express'
export * from './asyncHandler';
export * from './pagination';
export * from './demoData';

export class AppError extends Error {
  constructor(public statusCode: number, public message: string, public code?: string) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export interface PaginationParams { page: number; limit: number; offset: number; }

export function getPagination(page = 1, limit = 20): PaginationParams {
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(1000, Math.max(1, limit));
  return { page: safePage, limit: safeLimit, offset: (safePage - 1) * safeLimit };
}

export function sendSuccess(res: Response, data: any, message = 'Success', statusCode = 200) {
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

export function unauthorized(res: Response, error = 'Unauthorized') {
  res.status(401).json({ success: false, error });
}

export function conflict(res: Response, error: string) {
  res.status(409).json({ success: false, error });
}

export function serverError(res: Response, error = 'Internal server error') {
  res.status(500).json({ success: false, error });
}

export function sendPaginated(res: Response, data: any[], total: number, page: number, limit: number) {
  res.status(200).json({
    success: true, data,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit), hasNext: page * limit < total, hasPrev: page > 1 }
  });
}

export const isUUID = (id: any): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id));

// ── DEFINITIVE IST UTILS ──

/**
 * Returns a Date object shifted to IST (+5.5) regardless of system time.
 */
export function toIST(date: Date = new Date()): Date {
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  return new Date(utc + (3600000 * 5.5));
}

/**
 * Returns YYYY-MM-DD for the given Date in IST.
 */
export function isoDate(d: Date): string {
  const ist = toIST(d);
  const year = ist.getFullYear();
  const month = (ist.getMonth() + 1).toString().padStart(2, '0');
  const day = ist.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The only "Today" string we should use. Returns YYYY-MM-DD.
 */
export function dbToday(): string {
  return isoDate(new Date());
}

/**
 * Legacy support for DD--MM--YYYY format.
 */
export function todayDate(): string {
  const ist = toIST();
  const d = ist.getDate().toString().padStart(2, '0');
  const m = (ist.getMonth() + 1).toString().padStart(2, '0');
  const y = ist.getFullYear();
  return `${d}--${m}--${y}`;
}

/**
 * Parses various app input formats into IST YYYY-MM-DD.
 */
export function parseAppDate(appDate: string | null): string {
  if (!appDate || appDate === 'undefined' || appDate === 'null') return dbToday();
  const raw = appDate.trim();
  // If already YYYY-MM-DD, return first 10 chars
  if (raw.match(/^\d{4}-\d{2}-\d{2}/)) return raw.substring(0, 10);
  
  // Try separators: --, /, -
  const sep = raw.includes('--') ? '--' : (raw.includes('/') ? '/' : (raw.includes('-') ? '-' : null));
  if (sep) {
    const parts = raw.split(sep);
    if (parts.length === 3) {
      let p1 = parseInt(parts[0]), p2 = parseInt(parts[1]), y = parseInt(parts[2]);
      if (y < 100) y += 2000;
      let m, d;
      // Heuristic: DD/MM or MM/DD
      if (p1 > 12) { d = p1; m = p2; }
      else if (p2 > 12) { m = p1; d = p2; }
      else { 
        if (sep === '/') { m = p1; d = p2; } // Assume dashboard sends MM/DD/YYYY
        else { d = p1; m = p2; } // Assume app sends DD--MM--YYYY
      }
      return `${y}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
    }
  }
  return dbToday();
}

/**
 * CRITICAL: Converts an IST YYYY-MM-DD date into the correct UTC range for querying TIMESTAMPTZ columns.
 * Covers from 18:30 UTC of previous day to 18:29 UTC of target day.
 */
export function getISTSearchRange(istDate: string) {
  // istDate is YYYY-MM-DD
  const parts = istDate.split('-').map(Number);
  if (parts.length !== 3) {
    const today = new Date();
    parts[0] = today.getFullYear();
    parts[1] = today.getMonth() + 1;
    parts[2] = today.getDate();
  }
  const [y, m, d] = parts;
  
  // Start of Day: 00:00:00 IST = 18:30:00 UTC of PREVIOUS day
  // We use 18, 30, 0, 0 to be precise about the 5.5h offset
  const start = new Date(Date.UTC(y, m - 1, d - 1, 18, 30, 0, 0)).toISOString();
  
  // End of Day: 23:59:59.999 IST = 18:29:59.999 UTC of TARGET day
  const end = new Date(Date.UTC(y, m - 1, d, 18, 29, 59, 999)).toISOString();
  
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

export function clientId(req: Request): string | null {
  return (req as any).user?.client_id || null;
}
