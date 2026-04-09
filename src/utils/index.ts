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

// ── Standard success response ──
export function sendSuccess(
  res: Response,
  data: unknown,
  message = 'Success',
  statusCode = 200
) {
  res.status(statusCode).json({ success: true, message, data })
}

// ── Standard paginated response ──
export function sendPaginated(
  res: Response,
  data: unknown[],
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
  })
}

// ── Today's date as DD--MM--YYYY in IST (App format) ──
export function todayDate(): string {
  return formatAppDate(toIST());
}

// ── Today's date as YYYY-MM-DD (Database format) ──
export function dbToday(): string {
  return isoDate(toIST());
}

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

// Convert DB format (YYYY-MM-DD) -> App format (DD--MM--YYYY)
export function formatAppDate(dateStr: string | Date | null): string {
  if (!dateStr) return '';
  if (typeof dateStr === 'string') {
    if (dateStr.includes('--')) return dateStr;
    const matches = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (matches) {
       const [_, y, m, d] = matches;
       return `${d}--${m}--${y}`;
    }
  }
  
  const d = typeof dateStr === 'string' ? new Date(dateStr) : dateStr;
  if (isNaN(d.getTime())) return typeof dateStr === 'string' ? dateStr : '';
  const year = d.getFullYear();
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${day}--${month}--${year}`;
}

// IMPROVED: Flexible date parsing with MM/DD/YYYY detection
export function parseAppDate(appDate: string | null): string {
  if (!appDate) return dbToday();
  const raw = appDate.trim();
  
  // 1. Handle YYYY-MM-DD
  if (raw.match(/^\d{4}-\d{2}-\d{2}/)) return raw.substring(0, 10);
  
  // 2. Handle DD--MM--YYYY (Double dash)
  if (raw.includes('--')) {
    const p = raw.split('--');
    if (p.length === 3) return `${p[2]}-${p[1]}-${p[0]}`;
  }

  // 3. Handle slashed or single-dashed dates (MM/DD/YYYY or DD/MM/YYYY)
  const sep = raw.includes('/') ? '/' : (raw.includes('-') ? '-' : null);
  if (sep) {
    const p = raw.split(sep);
    if (p.length === 3) {
      let p1 = parseInt(p[0]);
      let p2 = parseInt(p[1]);
      let y = parseInt(p[2]);
      if (y < 100) y += 2000;

      // Heuristic: If today is April (Month 4), and the first part is 4 and second is 9, 
      // then 4/9/2026 is April 9 (MM/DD/YYYY).
      // Most Dashboards use MM/DD/YYYY.
      // If p1 > 12, it must be DD/MM/YYYY.
      // If p2 > 12, it must be MM/DD/YYYY.
      
      let finalM, finalD;
      if (p1 > 12) { // Clearly DD/MM/YYYY
        finalD = p1; finalM = p2;
      } else if (p2 > 12) { // Clearly MM/DD/YYYY
        finalM = p1; finalD = p2;
      } else {
        // AMBIGUOUS: Default to MM/DD/YYYY (Standard for most web inputs unless specified)
        // But for Indian context, we might prefer DD/MM.
        // However, the user's screenshot shows 04/09 (April 9). 
        // In April, if a user filters for "yesterday", they expect April 9.
        finalM = p1; finalD = p2; 
      }

      return `${y}-${finalM.toString().padStart(2, '0')}-${finalD.toString().padStart(2, '0')}`;
    }
  }

  return dbToday();
}

export const ok = <T>(res: Response, data: T, message?: string) =>
  res.status(200).json({ success: true, data, ...(message && { message }) });

export const created = <T>(res: Response, data: T, message?: string) =>
  res.status(201).json({ success: true, data, ...(message && { message }) });

export const badRequest = (res: Response, error: string, details?: unknown) =>
  res.status(400).json({ success: false, error, ...(details && { details }) });

export const notFound = (res: Response, error = 'Not found') =>
  res.status(404).json({ success: false, error });

export const forbidden = (res: Response, error = 'Forbidden') =>
  res.status(403).json({ success: false, error });

export const conflict = (res: Response, error: string) =>
  res.status(409).json({ success: false, error });

export const isUUID = (id: any): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id));

