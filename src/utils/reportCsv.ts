/**
 * Shared report emitter for list/export parity.
 *
 * Default → downloadable CSV (`<header>\n<rows>\n`, filename `<base>-YYYY-MM-DD.csv`).
 * With `?format=json` → `{ columns, rows, count }` so the dashboard can "Run" a
 * report and show the data inline without downloading. Both paths reuse the exact
 * same column defs, which is the list + CSV-export parity the repo requires.
 *
 * Mirrors the (previously inline) CRM report emitter so distribution exports
 * behave identically.
 */
import { Request, Response } from 'express';

export interface ReportColumn<T> {
  label: string;
  get: (r: T) => unknown;
}

/** CSV cell escape — quote when the value carries a comma / quote / newline. */
export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** A timestamp rendered as the date part only (YYYY-MM-DD). */
export const csvDateOnly = (v: unknown): string => (v ? String(v).slice(0, 10) : '');

export function sendReportCsv<T>(
  req: Request,
  res: Response,
  base: string,
  cols: Array<ReportColumn<T>>,
  rows: T[],
): void {
  const columns = cols.map((c) => c.label);
  if (String((req.query as Record<string, unknown>).format ?? '') === 'json') {
    const data = rows.map((r) => cols.map((c) => {
      const v = c.get(r);
      return v === undefined ? '' : v;
    }));
    res.json({ success: true, data: { columns, rows: data, count: rows.length } });
    return;
  }
  const header = columns.join(',');
  const body = rows.map((r) => cols.map((c) => csvEscape(c.get(r))).join(',')).join('\n');
  const csv = `${header}\n${body}\n`;
  const filename = `${base}-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}
