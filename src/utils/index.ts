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
export const ok = <T>(res: Response, data: T, message?: string) =>
  res.status(200).json({ success: true, data, ...(message && { message }) });

export const created = <T>(res: Response, data: T, message?: string) =>
  res.status(201).json({ success: true, data, ...(message && { message }) });

export const badRequest = (res: Response, error: string, details?: unknown) =>
  res.status(400).json({ success: false, error, ...(details && { details }) });

export const notFound = (res: Response, error = 'Not found') =>
  res.status(404).json({ success: false, error });

export const isUUID = (id: any): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id));

// ── TIMEZONE (IST) UTILS ──

// Guaranteed IST Date object
export function toIST(date: Date = new Date()): Date {
  // Use Intl to ensure we get a string in IST, then parse it back to a date object if needed
  // or just use the offset. offset for IST is +5.5 hours.
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  return new Date(utc + (3600000 * 5.5));
}

// YYYY-MM-DD from an IST context
export function dbToday(): string {
  const ist = toIST();
  return ist.toISOString().split('T')[0];
}

// DD--MM--YYYY for App internal compatibility
export function todayDate(): string {
  const ist = toIST();
  const d = ist.getDate().toString().padStart(2, '0');
  const m = (ist.getMonth() + 1).toString().padStart(2, '0');
  const y = ist.getFullYear();
  return `${d}--\n${m}--\n${y}`.replace(/\n/g, ''); // Defensive formatting
}

// Fixed version without weird newlines
export function getAppToday(): string {
  const ist = toIST();
  const d = ist.getDate().toString().padStart(2, '0');
  const m = (ist.getMonth() + 1).toString().padStart(2, '0');
  const y = ist.getFullYear();
  return `${d}--${m}--${y}`;
}

// Convert any string to YYYY-MM-DD reliably
export function parseAppDate(appDate: string | null): string {
  if (!appDate) return dbToday();
  const raw = appDate.trim();
  
  // Handle ISO/YYYY-MM-DD
  if (raw.match(/^\d{4}-\d{2}-\d{2}/)) return raw.substring(0, 10);
  
  // Handle formats with separators (--, -, /)
  const sep = raw.includes('--') ? '--' : (raw.includes('/') ? '/' : (raw.includes('-') ? '-' : null));
  if (sep) {
    const parts = raw.split(sep);
    if (parts.length === 3) {
      let p1 = parseInt(parts[0]);
      let p2 = parseInt(parts[1]);
      let y = parseInt(parts[2]);
      if (y < 100) y += 2000;

      // Heuristic: If dashboard sends dates, 04/09/2026 is April 9.
      // If p1 > 12, it's DD/MM/YYYY. If p2 > 12, it's MM/DD/YYYY.
      // Else, default to MM/DD (Dashboard default) or DD/MM (App default).
      // We will try to be smart - if it's April and we get 10/04, it's today (DD/MM).
      // If we get 04/10, it's today (MM/DD).
      
      let m, d;
      if (p1 > 12) { d = p1; m = p2; }
      else if (p2 > 12) { m = p1; d = p2; }
      else {
        // Dashboard sends slashed MM/DD, App sends dashed DD--MM
        if (sep === '/') { m = p1; d = p2; } 
        else { d = p1; m = p2; }
      }
      return `${y}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
    }
  }
  return dbToday();
}

// CRITICAL: Convert IST date part into UTC search range for Supabase
export function getISTSearchRange(istDate: string) {
  // istDate is YYYY-MM-DD
  // 00:00:00 IST = (prev day) 18:30:00 UTC
  // 23:59:59 IST = (same day) 18:29:59 UTC
  const d = new Date(`${istDate}T00:00:00`); // This is treated as local/UTC depending on env
  // Better: construct UTC boundaries manually
  const [y, m, day] = istDate.split('-').map(Number);
  
  // Start: IST 00:00:00 = UTC (prev day) 18:30:00
  const start = new Date(Date.UTC(y, m - 1, day - 1, 18, 30, 0)).toISOString();
  // End: IST 23:59:59 = UTC (this day) 18:29:59
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
