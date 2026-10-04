import PDFDocument from 'pdfkit';
import { amountInWords } from './money';
import { stateLabel } from './gstStates';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RenderInput { doc: Row; items: Row[]; settings: Row; payments?: Row[] }

const A4 = { w: 595.28, h: 841.89 };
const M = 40;

// Standard PDF fonts have no ₹ glyph, so amounts print as "Rs.".
const money = (n: unknown) => `Rs. ${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plain = (n: unknown) => Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (iso?: string | null) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');

function addressLines(a?: Row | null): string[] {
  if (!a) return [];
  const cityLine = [a.city, a.state, a.pincode].filter(Boolean).join(', ');
  return [a.attention, a.line1, a.line2, cityLine, a.country && a.country !== 'India' ? a.country : '', a.phone ? `Phone: ${a.phone}` : '']
    .filter((x) => x && String(x).trim()).map(String);
}

function isPrivateHost(host: string) {
  return /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$)/i.test(host) || host.endsWith('.internal') || host.endsWith('.local');
}

async function fetchLogo(url?: string | null): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || isPrivateHost(u.hostname)) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const res = await fetch(u, { signal: ctl.signal });
    clearTimeout(timer);
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/image\/(png|jpe?g)/i.test(type)) return null; // pdfkit only embeds PNG/JPEG
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length <= 1_500_000 ? buf : null;
  } catch {
    return null;
  }
}

export async function renderDocumentPdf({ doc, items, settings, payments = [] }: RenderInput): Promise<Buffer> {
  const isInvoice = doc.doc_type === 'invoice';
  const tpl = (settings.template || {}) as Row;
  const bank = (settings.bank_details || {}) as Row;
  const accent = /^#[0-9a-fA-F]{6}$/.test(tpl.accent_color || '') ? tpl.accent_color : '#E01E2C';
  const logo = tpl.show_logo === false ? null : await fetchLogo(settings.logo_url);
  const intra = Number(doc.igst) === 0;

  const pdf = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: `${isInvoice ? 'Invoice' : 'Quote'} ${doc.number}` } });
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });

  const contentW = A4.w - M * 2;
  const bottom = A4.h - 60;
  const ink = '#1f2328', dim = '#6b7280', line = '#e5e7eb';

  // ── header: seller (left) + document title (right) ────────────────────────
  let y = M;
  let textX = M;
  if (logo) {
    try { pdf.image(logo, M, y, { fit: [70, 56] }); textX = M + 82; } catch { /* unreadable image — skip */ }
  }
  pdf.fillColor(ink).font('Helvetica-Bold').fontSize(14).text(settings.business_name || 'Business', textX, y, { width: 270 });
  pdf.font('Helvetica').fontSize(8.5).fillColor(dim);
  const sellerLines = [
    ...addressLines({ line1: settings.address_line1, line2: settings.address_line2, city: settings.city, state: settings.state, pincode: settings.pincode, country: settings.country }),
    settings.gstin ? `GSTIN: ${settings.gstin}` : '',
    settings.email, settings.phone, settings.website,
  ].filter(Boolean);
  pdf.text(sellerLines.join('\n'), textX, pdf.y + 2, { width: 270, lineGap: 1.5 });
  const leftEnd = pdf.y;

  const rightX = A4.w - M - 220;
  pdf.font('Helvetica-Bold').fontSize(22).fillColor(accent)
    .text(isInvoice ? 'TAX INVOICE' : 'QUOTE', rightX, y, { width: 220, align: 'right' });
  pdf.font('Helvetica').fontSize(10).fillColor(ink).text(`# ${doc.number}`, rightX, pdf.y + 2, { width: 220, align: 'right' });
  const statusText = String(doc.display_status || doc.status || '').replace('_', ' ').toUpperCase();
  if (statusText && statusText !== 'DRAFT') {
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(doc.status === 'paid' ? '#16a34a' : doc.status === 'void' ? '#9ca3af' : accent)
      .text(statusText, rightX, pdf.y + 2, { width: 220, align: 'right' });
  }
  if (isInvoice) {
    const balance = Number(doc.balance);
    pdf.font('Helvetica').fontSize(8.5).fillColor(dim).text('Balance Due', rightX, pdf.y + 8, { width: 220, align: 'right' });
    pdf.font('Helvetica-Bold').fontSize(13).fillColor(ink).text(money(doc.status === 'void' ? 0 : balance), rightX, pdf.y, { width: 220, align: 'right' });
  }
  y = Math.max(leftEnd, pdf.y) + 14;
  pdf.moveTo(M, y).lineTo(A4.w - M, y).lineWidth(0.8).strokeColor(line).stroke();
  y += 12;

  // ── meta + bill to / ship to ─────────────────────────────────────────────
  const meta: Array<[string, string]> = [
    [isInvoice ? 'Invoice Date' : 'Quote Date', dmy(doc.issue_date)],
    ...(isInvoice
      ? [['Terms', Number(doc.payment_terms_days) ? `Net ${doc.payment_terms_days}` : 'Due on Receipt'] as [string, string],
         ['Due Date', dmy(doc.due_date)] as [string, string]]
      : [['Expiry Date', dmy(doc.expiry_date)] as [string, string]]),
    ...(doc.reference_number ? [['Order / Ref #', String(doc.reference_number)] as [string, string]] : []),
    ...(doc.place_of_supply ? [['Place of Supply', stateLabel(doc.place_of_supply)] as [string, string]] : []),
  ];
  let metaY = y;
  for (const [k, v] of meta) {
    pdf.font('Helvetica').fontSize(8.5).fillColor(dim).text(k, M, metaY, { width: 90 });
    pdf.font('Helvetica-Bold').fillColor(ink).text(v, M + 95, metaY, { width: 150 });
    metaY += 14;
  }

  const cust = (doc.customer_snapshot || {}) as Row;
  const boxX = 300, boxW = (A4.w - M - boxX - 10) / 2;
  const party = (title: string, x: number, name: string, addr: Row | null, extra: string[]) => {
    pdf.font('Helvetica-Bold').fontSize(8).fillColor(dim).text(title, x, y, { width: boxW });
    pdf.font('Helvetica-Bold').fontSize(9.5).fillColor(accent).text(name, x, pdf.y + 2, { width: boxW });
    pdf.font('Helvetica').fontSize(8.5).fillColor(ink).text([...addressLines(addr), ...extra].join('\n'), x, pdf.y + 1, { width: boxW, lineGap: 1.5 });
    return pdf.y;
  };
  const e1 = party('BILL TO', boxX, cust.name || '', doc.bill_to, cust.gstin ? [`GSTIN: ${cust.gstin}`] : []);
  const shipAddr = addressLines(doc.ship_to).length ? doc.ship_to : null;
  const e2 = shipAddr ? party('SHIP TO', boxX + boxW + 10, cust.name || '', shipAddr, []) : y;
  y = Math.max(metaY, e1, e2) + 14;

  if (doc.subject) {
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(ink).text(`Subject: ${doc.subject}`, M, y, { width: contentW });
    y = pdf.y + 8;
  }

  // ── line items ────────────────────────────────────────────────────────────
  const cols = [
    { k: '#', w: 22, a: 'left' }, { k: 'Item & Description', w: 0, a: 'left' }, { k: 'HSN/SAC', w: 54, a: 'left' },
    { k: 'Qty', w: 44, a: 'right' }, { k: 'Rate', w: 62, a: 'right' }, { k: 'Disc %', w: 38, a: 'right' },
    { k: 'GST %', w: 38, a: 'right' }, { k: 'Amount', w: 68, a: 'right' },
  ] as Array<{ k: string; w: number; a: 'left' | 'right' }>;
  cols[1].w = contentW - cols.reduce((s, c) => s + c.w, 0);
  const xs: number[] = []; cols.reduce((x, c) => { xs.push(x); return x + c.w; }, M);

  const drawHead = (at: number) => {
    pdf.rect(M, at, contentW, 20).fill(accent);
    pdf.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
    cols.forEach((c, i) => pdf.text(c.k, xs[i] + 4, at + 6, { width: c.w - 8, align: c.a }));
    return at + 20;
  };
  y = drawHead(y);

  items.forEach((it, idx) => {
    const desc = [it.description].filter(Boolean).join('');
    pdf.font('Helvetica-Bold').fontSize(8.5);
    const h1 = pdf.heightOfString(String(it.name), { width: cols[1].w - 8 });
    pdf.font('Helvetica').fontSize(7.5);
    const h2 = desc ? pdf.heightOfString(desc, { width: cols[1].w - 8 }) : 0;
    const rowH = Math.max(h1 + h2 + 10, 22);
    if (y + rowH > bottom) { pdf.addPage(); y = drawHead(M); }
    pdf.font('Helvetica').fontSize(8.5).fillColor(ink);
    const cell = (i: number, t: string) => pdf.text(t, xs[i] + 4, y + 6, { width: cols[i].w - 8, align: cols[i].a });
    cell(0, String(idx + 1));
    pdf.font('Helvetica-Bold').fontSize(8.5).text(String(it.name), xs[1] + 4, y + 6, { width: cols[1].w - 8 });
    if (desc) pdf.font('Helvetica').fontSize(7.5).fillColor(dim).text(desc, xs[1] + 4, pdf.y, { width: cols[1].w - 8 });
    pdf.font('Helvetica').fontSize(8.5).fillColor(ink);
    cell(2, it.hsn_sac || '');
    cell(3, `${Number(it.quantity)}${it.unit ? ` ${it.unit}` : ''}`);
    cell(4, plain(it.rate));
    cell(5, Number(it.discount_pct) ? String(Number(it.discount_pct)) : '');
    cell(6, String(Number(it.gst_rate)));
    cell(7, plain(it.taxable_value));
    y += rowH;
    pdf.moveTo(M, y).lineTo(A4.w - M, y).lineWidth(0.5).strokeColor(line).stroke();
  });
  y += 10;

  // ── totals ────────────────────────────────────────────────────────────────
  const byRate = new Map<number, { cgst: number; sgst: number; igst: number }>();
  for (const it of items) {
    const r = Number(it.gst_rate);
    const cur = byRate.get(r) ?? { cgst: 0, sgst: 0, igst: 0 };
    cur.cgst += Number(it.cgst); cur.sgst += Number(it.sgst); cur.igst += Number(it.igst);
    byRate.set(r, cur);
  }
  const totals: Array<[string, string, boolean?]> = [['Sub Total', plain(Number(doc.subtotal) - Number(doc.discount_total))]];
  if (Number(doc.discount_total) > 0) totals[0] = ['Sub Total (before discount)', plain(doc.subtotal)], totals.push(['Discount', `(-) ${plain(doc.discount_total)}`]);
  for (const [rate, t] of Array.from(byRate.entries()).sort((a, b) => a[0] - b[0])) {
    if (rate === 0) continue;
    if (intra) { totals.push([`CGST (${rate / 2}%)`, plain(t.cgst)], [`SGST (${rate / 2}%)`, plain(t.sgst)]); }
    else totals.push([`IGST (${rate}%)`, plain(t.igst)]);
  }
  if (Number(doc.adjustment)) totals.push([doc.adjustment_label || 'Adjustment', plain(doc.adjustment)]);
  if (Number(doc.round_off)) totals.push(['Round Off', plain(doc.round_off)]);
  totals.push(['Total', money(doc.total), true]);
  if (isInvoice && Number(doc.amount_paid) > 0) {
    totals.push(['Payment Made', `(-) ${plain(doc.amount_paid)}`]);
    totals.push(['Balance Due', money(doc.status === 'void' ? 0 : doc.balance), true]);
  }

  const wordsH = 40, totalsH = totals.length * 16 + 10;
  if (y + Math.max(wordsH, totalsH) > bottom) { pdf.addPage(); y = M; }
  const tx = A4.w - M - 230;
  let ty = y;
  for (const [k, v, bold] of totals) {
    if (bold) pdf.rect(tx - 6, ty - 3, 236, 18).fill('#f3f4f6');
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 9.5 : 8.5).fillColor(ink);
    pdf.text(k, tx, ty, { width: 110 });
    pdf.text(v, tx + 110, ty, { width: 120, align: 'right' });
    ty += 16;
  }
  pdf.font('Helvetica').fontSize(8).fillColor(dim).text('Total In Words', M, y, { width: 250 });
  pdf.font('Helvetica-BoldOblique').fontSize(8.5).fillColor(ink).text(amountInWords(Number(doc.total), settings.currency || 'INR'), M, pdf.y + 2, { width: 250 });
  y = Math.max(ty, pdf.y) + 14;

  // ── notes / terms / bank / signature ──────────────────────────────────────
  const block = (title: string, body: string) => {
    if (!body.trim()) return;
    pdf.font('Helvetica-Bold').fontSize(8.5);
    const h = pdf.heightOfString(body, { width: contentW }) + 24;
    if (y + h > bottom) { pdf.addPage(); y = M; }
    pdf.font('Helvetica-Bold').fontSize(8.5).fillColor(ink).text(title, M, y);
    pdf.font('Helvetica').fontSize(8).fillColor(dim).text(body, M, pdf.y + 2, { width: contentW, lineGap: 1.5 });
    y = pdf.y + 10;
  };
  block('Notes', doc.notes || '');
  if (isInvoice && tpl.show_bank_details !== false) {
    const rows = [
      bank.account_name && `Account Name: ${bank.account_name}`, bank.bank_name && `Bank: ${bank.bank_name}`,
      bank.account_number && `Account No: ${bank.account_number}`, bank.ifsc && `IFSC: ${bank.ifsc}`,
      bank.branch && `Branch: ${bank.branch}`, bank.upi_id && `UPI: ${bank.upi_id}`,
    ].filter(Boolean) as string[];
    block('Bank Details', rows.join('   |   '));
  }
  block('Terms & Conditions', doc.terms || '');
  if (tpl.signature_name) {
    if (y + 50 > bottom) { pdf.addPage(); y = M; }
    pdf.moveTo(A4.w - M - 160, y + 30).lineTo(A4.w - M, y + 30).lineWidth(0.6).strokeColor(dim).stroke();
    pdf.font('Helvetica').fontSize(8).fillColor(dim).text(`For ${settings.business_name || ''}`, A4.w - M - 160, y + 34, { width: 160, align: 'center' });
    pdf.text(String(tpl.signature_name), A4.w - M - 160, pdf.y, { width: 160, align: 'center' });
  }

  // ── watermark + footer on every page ──────────────────────────────────────
  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(range.start + i);
    // Footer/watermark sit inside the bottom margin; without this pdfkit appends a blank page per write.
    pdf.page.margins.bottom = 0;
    if (doc.status === 'void') {
      pdf.save().rotate(-35, { origin: [A4.w / 2, A4.h / 2] }).font('Helvetica-Bold').fontSize(110).fillColor('#9ca3af').opacity(0.15)
        .text('VOID', 0, A4.h / 2 - 60, { width: A4.w, align: 'center', lineBreak: false }).restore();
    }
    pdf.opacity(1).font('Helvetica').fontSize(7.5).fillColor(dim);
    const foot = (tpl.footer_text as string) || '';
    if (foot) pdf.text(foot, M, A4.h - 46, { width: contentW, align: 'center', lineBreak: false });
    pdf.text(`Page ${i + 1} of ${range.count}`, M, A4.h - 32, { width: contentW, align: 'center', lineBreak: false });
  }
  pdf.end();
  return done;
}
