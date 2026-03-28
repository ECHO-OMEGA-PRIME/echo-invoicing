import { Hono } from 'hono';
import { cors } from 'hono/cors';

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────
interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ENGINE_RUNTIME: Fetcher;
  SHARED_BRAIN: Fetcher;
  EMAIL_SENDER: Fetcher;
  ECHO_API_KEY: string;
}

interface Tenant {
  id: string;
  name: string;
  email: string;
  company?: string;
  tax_id?: string;
  address?: string;
  currency: string;
  payment_terms: string;
  created_at: string;
}

interface Client {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  company?: string;
  address?: string;
  phone?: string;
  notes?: string;
  created_at: string;
}

interface InvoiceItem {
  id?: string;
  invoice_id?: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  tax_rate: number;
  sort_order: number;
}

interface Invoice {
  id: string;
  tenant_id: string;
  client_id: string;
  invoice_number: string;
  status: string;
  issue_date: string;
  due_date: string;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  discount: number;
  total: number;
  notes?: string;
  payment_link?: string;
  sent_at?: string;
  paid_at?: string;
  created_at: string;
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────
function uid(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function log(level: string, event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, event, service: 'echo-invoicing', ts: new Date().toISOString(), ...data }));
}

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, ...((typeof data === 'object' && data !== null) ? data : { data }) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(message: string, status = 400, details?: unknown): Response {
  return new Response(JSON.stringify({ ok: false, error: message, ...(details ? { details } : {}) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requireAuth(c: { req: { header: (k: string) => string | undefined } }, env: Env): boolean {
  const key = c.req.header('X-Echo-API-Key');
  return key === env.ECHO_API_KEY;
}

function calcInvoiceTotals(items: InvoiceItem[], taxRate: number, discount: number): { subtotal: number; tax_amount: number; total: number } {
  const subtotal = items.reduce((sum, it) => sum + (it.quantity * it.unit_price), 0);
  const taxable = subtotal - discount;
  const tax_amount = parseFloat((taxable * (taxRate / 100)).toFixed(2));
  const total = parseFloat((taxable + tax_amount).toFixed(2));
  return { subtotal: parseFloat(subtotal.toFixed(2)), tax_amount, total };
}

function addFrequencyDays(dateStr: string, freq: string): string {
  const d = new Date(dateStr);
  switch (freq) {
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'biweekly': d.setDate(d.getDate() + 14); break;
    case 'monthly': d.setMonth(d.getMonth() + 1); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'yearly': d.setFullYear(d.getFullYear() + 1); break;
  }
  return d.toISOString().split('T')[0];
}

// ─────────────────────────────────────────
// App
// ─────────────────────────────────────────
const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'X-Echo-API-Key'], allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }));

// ─────────────────────────────────────────
// Health & Status
// ─────────────────────────────────────────
app.get('/', (c) => c.json({ service: 'echo-invoicing', version: '1.0.0', status: 'operational' }));

app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'echo-invoicing', version: '1.0.0', timestamp: new Date().toISOString() });
});

app.get('/status', async (c) => {
  let d1Status = 'connected';
  try {
    await c.env.DB.prepare('SELECT 1').first();
  } catch {
    d1Status = 'error';
  }
  return c.json({
    ok: true,
    service: 'echo-invoicing',
    version: '1.0.0',
    d1: d1Status,
    features: ['tenants', 'clients', 'invoices', 'payments', 'recurring', 'ai-analysis', 'reports', 'pdf-export'],
  });
});

// ─────────────────────────────────────────
// TENANTS
// ─────────────────────────────────────────
app.post('/tenants', async (c) => {
  if (!requireAuth(c, c.env)) return err('Unauthorized', 401);
  const body = await c.req.json<Partial<Tenant>>();
  if (!body.name || !body.email) return err('name and email required');
  const id = uid();
  try {
    await c.env.DB.prepare(
      `INSERT INTO tenants (id, name, email, company, tax_id, address, currency, payment_terms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, body.name, body.email, body.company ?? null, body.tax_id ?? null, body.address ?? null, body.currency ?? 'USD', body.payment_terms ?? 'net30').run();
    log('info', 'tenant.created', { id });
    const tenant = await c.env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(id).first<Tenant>();
    return c.json({ ok: true, tenant }, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log('error', 'tenant.create.failed', { error: msg });
    if (msg.includes('UNIQUE')) return err('Email already registered', 409);
    return err('Failed to create tenant', 500);
  }
});

app.get('/tenants/:id', async (c) => {
  const tenant = await c.env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(c.req.param('id')).first<Tenant>();
  if (!tenant) return err('Tenant not found', 404);
  return c.json({ ok: true, tenant });
});

// ─────────────────────────────────────────
// CLIENTS
// ─────────────────────────────────────────
app.get('/clients', async (c) => {
  const tenantId = c.req.query('tenant_id');
  if (!tenantId) return err('tenant_id required');
  const clients = await c.env.DB.prepare('SELECT * FROM clients WHERE tenant_id = ? ORDER BY name').bind(tenantId).all<Client>();
  return c.json({ ok: true, clients: clients.results, total: clients.results.length });
});

app.post('/clients', async (c) => {
  if (!requireAuth(c, c.env)) return err('Unauthorized', 401);
  const body = await c.req.json<Partial<Client>>();
  if (!body.tenant_id || !body.name || !body.email) return err('tenant_id, name, and email required');
  const id = uid();
  await c.env.DB.prepare(
    `INSERT INTO clients (id, tenant_id, name, email, company, address, phone, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, body.tenant_id, body.name, body.email, body.company ?? null, body.address ?? null, body.phone ?? null, body.notes ?? null).run();
  log('info', 'client.created', { id, tenant_id: body.tenant_id });
  const client = await c.env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first<Client>();
  return c.json({ ok: true, client }, 201);
});

app.get('/clients/:id', async (c) => {
  const client = await c.env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(c.req.param('id')).first<Client>();
  if (!client) return err('Client not found', 404);
  return c.json({ ok: true, client });
});

app.put('/clients/:id', async (c) => {
  if (!requireAuth(c, c.env)) return err('Unauthorized', 401);
  const body = await c.req.json<Partial<Client>>();
  const existing = await c.env.DB.prepare('SELECT id FROM clients WHERE id = ?').bind(c.req.param('id')).first();
  if (!existing) return err('Client not found', 404);
  await c.env.DB.prepare(
    `UPDATE clients SET name = COALESCE(?, name), email = COALESCE(?, email),
     company = COALESCE(?, company), address = COALESCE(?, address),
     phone = COALESCE(?, phone), notes = COALESCE(?, notes) WHERE id = ?`
  ).bind(body.name ?? null, body.email ?? null, body.company ?? null, body.address ?? null, body.phone ?? null, body.notes ?? null, c.req.param('id')).run();
  const client = await c.env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(c.req.param('id')).first<Client>();
  return c.json({ ok: true, client });
});

app.delete('/clients/:id', async (c) => {
  if (!requireAuth(c, c.env)) return err('Unauthorized', 401);
  const existing = await c.env.DB.prepare('SELECT id FROM clients WHERE id = ?').bind(c.req.param('id')).first();
  if (!existing) return err('Client not found', 404);
  await c.env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(c.req.param('id')).run();
  log('info', 'client.deleted', { id: c.req.param('id') });
  return c.json({ ok: true, deleted: c.req.param('id') });
});

// ─────────────────────────────────────────
// INVOICES
// ─────────────────────────────────────────
app.get('/invoices', async (c) => {
  const q = c.req.query;
  const tenantId = q('tenant_id');
  if (!tenantId) return err('tenant_id required');

  let sql = 'SELECT i.*, c.name as client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id WHERE i.tenant_id = ?';
  const params: (string | null)[] = [tenantId];

  if (q('status')) { sql += ' AND i.status = ?'; params.push(q('status')!); }
  if (q('client_id')) { sql += ' AND i.client_id = ?'; params.push(q('client_id')!); }
  if (q('from')) { sql += ' AND i.issue_date >= ?'; params.push(q('from')!); }
  if (q('to')) { sql += ' AND i.issue_date <= ?'; params.push(q('to')!); }

  sql += ' ORDER BY i.created_at DESC';
  const limit = Math.min(parseInt(q('limit') ?? '50'), 200);
  const offset = parseInt(q('offset') ?? '0');
  sql += ` LIMIT ${limit} OFFSET ${offset}`;

  const invoices = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ ok: true, invoices: invoices.results, total: invoices.results.length });
});

app.post('/invoices', async (c) => {
  if (!requireAuth(c, c.env)) return err('Unauthorized', 401);
  const body = await c.req.json<{
    tenant_id: string; client_id: string; invoice_number?: string; issue_date?: string;
    due_date: string; tax_rate?: number; discount?: number; notes?: string; items: InvoiceItem[];
  }>();
  if (!body.tenant_id || !body.client_id || !body.due_date) return err('tenant_id, client_id, due_date required');
  if (!body.items || body.items.length === 0) return err('At least one invoice item required');

  const id = uid();
  const invoiceNum = body.invoice_number ?? `INV-${Date.now()}`;
  const items: InvoiceItem[] = body.items.map((it, idx) => ({
    ...it,
    amount: parseFloat((it.quantity * it.unit_price).toFixed(2)),
    sort_order: it.sort_order ?? idx,
  }));
  const taxRate = body.tax_rate ?? 0;
  const discount = body.discount ?? 0;
  const { subtotal, tax_amount, total } = calcInvoiceTotals(items, taxRate, discount);

  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO invoices (id, tenant_id, client_id, invoice_number, issue_date, due_date, subtotal, tax_rate, tax_amount, discount, total, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, body.tenant_id, body.client_id, invoiceNum, body.issue_date ?? new Date().toISOString().split('T')[0], body.due_date, subtotal, taxRate, tax_amount, discount, total, body.notes ?? null),
    ...items.map((it) =>
      c.env.DB.prepare(
        `INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, tax_rate, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(uid(), id, it.description, it.quantity, it.unit_price, it.amount, it.tax_rate ?? 0, it.sort_order)
    ),
  ];

  await c.env.DB.batch(stmts);
  log('info', 'invoice.created', { id, tenant_id: body.tenant_id, total });
  const invoice = await c.env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first<Invoice>();
  const invoiceItems = await c.env.DB.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order').bind(id).all<InvoiceItem>();
  return c.json({ ok: true, invoice: { ...invoice, items: invoiceItems.results } }, 201);
});

app.get('/invoices/:id', async (c) => {
  const invoice = await c.env.DB.prepare('SELECT i.*, c.name as client_name, c.email as client_email, c.company as client_company, c.address as client_address FROM invoices i LEFT JOIN clients c ON c.id = i.client_id WHERE i.id = ?').bind(c.req.param('id')).first<Invoice & Record<string, unknown>>();
  if (!invoice) return err('Invoice not found', 404);
  const items = await c.env.DB.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order').bind(c.req.param('id')).all<InvoiceItem>();
  const payments = await c.env.DB.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY paid_at').bind(c.req.param('id')).all();
  return c.json({ ok: true, invoice: { ...invoice, items: items.results, payments: payments.results } });
});

app.put('/invoices/:id', async (c) => {
  if (!requireAuth(c, c.env)) return err('Unauthorized', 401);
  const body = await c.req.json<Partial<Invoice & { items?: InvoiceItem[] }>>();
  const existing = await c.env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(c.req.param('id')).first<Invoice>();
  if (!existing) return err('Invoice not found', 404);

  let subtotal = existing.subtotal, tax_amount = existing.tax_amount, total = existing.total;
  const stmts: D1PreparedStatement[] = [];

  if (body.items && body.items.length > 0) {
    const items = body.items.map((it, idx) => ({ ...it, amount: parseFloat((it.quantity * it.unit_price).toFixed(2)), sort_order: it.sort_order ?? idx }));
    const totals = calcInvoiceTotals(items, body.tax_rate ?? existing.tax_rate, body.discount ?? existing.discount);
    subtotal = totals.subtotal; tax_amount = totals.tax_amount; total = totals.total;
    stmts.push(c.env.DB.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').bind(c.req.param('id')));
    stmts.push(...items.map(it => c.env.DB.prepare(`INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, tax_rate, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(uid(), c.req.param('id'), it.description, it.quantity, it.unit_price, it.amount, it.tax_rate ?? 0, it.sort_order)));
  }

  stmts.push(c.env.DB.prepare(
    `UPDATE invoices SET due_date = COALESCE(?, due_date), status = COALESCE(?, status), notes = COALESCE(?, notes),
     tax_rate = ?, tax_amount = ?, discount = COALESCE(?, discount), subtotal = ?, total = ? WHERE id = ?`
  ).bind(body.due_date ?? null, body.status ?? null, body.notes ?? null, body.tax_rate ?? existing.tax_rate, tax_amount, body.discount ?? null, subtotal, total, c.req.param('id')));

  await c.env.DB.batch(stmts);
  const invoice = await c.env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(c.req.param('id')).first<Invoice>();
  const items = await c.env.DB.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order').bind(c.req.param('id')).all<InvoiceItem>();
  return c.json({ ok: true, invoice: { ...invoice, items: items.results } });
});

app.delete('/invoices/:id', async (c) => {
  if (!requireAuth(c, c.env)) return err('Unauthorized', 401);
  const existing = await c.env.DB.prepare('SELECT id, status FROM invoices WHERE id = ?').bind(c.req.param('id')).first<{ id: string; status: string }>();
  if (!existing) return err('Invoice not found', 404);
  if (existing.status === 'paid') return err('Cannot delete a paid invoice', 409);
  await c.env.DB.prepare('DELETE FROM invoices WHERE id = ?').bind(c.req.param('id')).run();
  log('info', 'invoice.deleted', { id: c.req.param('id') });
  return c.json({ ok: true, deleted: c.req.param('id') });
});

// ─────────────────────────────────────────
// SEND INVOICE
// ─────────────────────────────────────────
app.post('/invoices/:id/send', async (c) => {
  if (!requireAuth(c, c.env)) return err('Unauthorized', 401);
  const invoice = await c.env.DB.prepare(
    'SELECT i.*, c.email as client_email, c.name as client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id WHERE i.id = ?'
  ).bind(c.req.param('id')).first<Invoice & { client_email: string; client_name: string }>();
  if (!invoice) return err('Invoice not found', 404);
  if (invoice.status === 'paid') return err('Invoice already paid');
  if (invoice.status === 'cancelled') return err('Invoice is cancelled');

  await c.env.DB.prepare("UPDATE invoices SET status = 'sent', sent_at = ? WHERE id = ?").bind(new Date().toISOString(), c.req.param('id')).run();

  try {
    await c.env.EMAIL_SENDER.fetch('https://echo-email-sender.internal/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: invoice.client_email,
        subject: `Invoice ${invoice.invoice_number} — $${invoice.total.toFixed(2)} due ${invoice.due_date}`,
        html: `<p>Hi ${invoice.client_name},</p><p>Please find your invoice #${invoice.invoice_number} for $${invoice.total.toFixed(2)} due on ${invoice.due_date}.</p>${invoice.payment_link ? `<p><a href="${invoice.payment_link}">Pay Now</a></p>` : ''}`,
        text: `Invoice ${invoice.invoice_number}: $${invoice.total.toFixed(2)} due ${invoice.due_date}`,
      }),
    });
  } catch (e) {
    log('warn', 'invoice.send.email_failed', { id: c.req.param('id'), error: String(e) });
  }

  log('info', 'invoice.sent', { id: c.req.param('id'), to: invoice.client_email });
  return c.json({ ok: true, message: 'Invoice marked as sent', invoice_id: c.req.param('id'), sent_to: invoice.client_email });
});

// ─────────────────────────────────────────
// RECORD PAYMENT
// ─────────────────────────────────────────
app.post('/invoices/:id/record-payment', async (c) => {
  if (!requireAuth(c, c.env)) return err('Unauthorized', 401);
  const body = await c.req.json<{ amount: number; method?: string; reference?: string; notes?: string; paid_at?: string }>();
  if (!body.amount || body.amount <= 0) return err('amount must be positive');

  const invoice = await c.env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(c.req.param('id')).first<Invoice>();
  if (!invoice) return err('Invoice not found', 404);
  if (invoice.status === 'cancelled') return err('Cannot record payment on cancelled invoice');

  const payId = uid();
  const paid_at = body.paid_at ?? new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO payments (id, tenant_id, invoice_id, amount, method, reference, notes, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(payId, invoice.tenant_id, c.req.param('id'), body.amount, body.method ?? 'card', body.reference ?? null, body.notes ?? null, paid_at).run();

  const paymentsResult = await c.env.DB.prepare('SELECT COALESCE(SUM(amount), 0) as total_paid FROM payments WHERE invoice_id = ?').bind(c.req.param('id')).first<{ total_paid: number }>();
  const totalPaid = paymentsResult?.total_paid ?? 0;

  const newStatus = totalPaid >= invoice.total ? 'paid' : invoice.status;
  if (newStatus === 'paid') {
    await c.env.DB.prepare("UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?").bind(paid_at, c.req.param('id')).run();
  }

  log('info', 'payment.recorded', { payment_id: payId, invoice_id: c.req.param('id'), amount: body.amount, total_paid: totalPaid, new_status: newStatus });
  return c.json({ ok: true, payment_id: payId, total_paid: parseFloat(totalPaid.toFixed(2)), invoice_status: newStatus, fully_paid: newStatus === 'paid' }, 201);
});

// ─────────────────────────────────────────
// PDF / HTML INVOICE
// ─────────────────────────────────────────
app.get('/invoices/:id/pdf', async (c) => {
  const invoice = await c.env.DB.prepare(
    `SELECT i.*, t.name as tenant_name, t.email as tenant_email, t.company as tenant_company,
     t.address as tenant_address, t.tax_id as tenant_tax_id,
     c.name as client_name, c.email as client_email, c.company as client_company, c.address as client_address
     FROM invoices i
     LEFT JOIN tenants t ON t.id = i.tenant_id
     LEFT JOIN clients c ON c.id = i.client_id
     WHERE i.id = ?`
  ).bind(c.req.param('id')).first<Invoice & Record<string, string | number | null>>();
  if (!invoice) return err('Invoice not found', 404);
  const items = await c.env.DB.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order').bind(c.req.param('id')).all<InvoiceItem>();

  const itemRows = items.results.map(it =>
    `<tr><td>${it.description}</td><td style="text-align:center">${it.quantity}</td><td style="text-align:right">$${it.unit_price.toFixed(2)}</td><td style="text-align:right">$${it.amount.toFixed(2)}</td></tr>`
  ).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Invoice ${invoice.invoice_number}</title>
<style>
  body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;color:#222;font-size:14px}
  h1{color:#1a1a2e;margin:0}.header{display:flex;justify-content:space-between;margin-bottom:40px}
  .from,.to{flex:1}.badge{display:inline-block;padding:4px 12px;border-radius:4px;font-size:12px;font-weight:bold;background:#e8f5e9;color:#2e7d32;text-transform:uppercase}
  table{width:100%;border-collapse:collapse;margin:24px 0}th{background:#1a1a2e;color:#fff;padding:10px;text-align:left}
  td{padding:8px 10px;border-bottom:1px solid #eee}.totals{text-align:right;margin-top:8px}
  .total-row td{font-weight:bold;font-size:16px;color:#1a1a2e}.footer{margin-top:40px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#777}
  @media print{body{margin:20px}}
</style>
</head>
<body>
<div class="header">
  <div class="from">
    <h1>${invoice.tenant_company || invoice.tenant_name}</h1>
    <p>${invoice.tenant_address || ''}</p>
    <p>${invoice.tenant_email}</p>
    ${invoice.tenant_tax_id ? `<p>Tax ID: ${invoice.tenant_tax_id}</p>` : ''}
  </div>
  <div style="text-align:right">
    <h2 style="color:#1a1a2e">INVOICE</h2>
    <p><strong>#${invoice.invoice_number}</strong></p>
    <p>Issued: ${invoice.issue_date}</p>
    <p>Due: ${invoice.due_date}</p>
    <span class="badge">${invoice.status}</span>
  </div>
</div>
<div class="to">
  <strong>Bill To:</strong>
  <p>${invoice.client_company ? `${invoice.client_company}<br>` : ''}${invoice.client_name}<br>${invoice.client_email}<br>${invoice.client_address || ''}</p>
</div>
<table>
  <thead><tr><th>Description</th><th style="text-align:center">Qty</th><th style="text-align:right">Unit Price</th><th style="text-align:right">Amount</th></tr></thead>
  <tbody>${itemRows}</tbody>
</table>
<div class="totals">
  <p>Subtotal: <strong>$${Number(invoice.subtotal).toFixed(2)}</strong></p>
  ${Number(invoice.discount) > 0 ? `<p>Discount: <strong>-$${Number(invoice.discount).toFixed(2)}</strong></p>` : ''}
  ${Number(invoice.tax_rate) > 0 ? `<p>Tax (${invoice.tax_rate}%): <strong>$${Number(invoice.tax_amount).toFixed(2)}</strong></p>` : ''}
  <p style="font-size:18px;color:#1a1a2e">Total: <strong>$${Number(invoice.total).toFixed(2)}</strong></p>
</div>
${invoice.notes ? `<div style="margin-top:24px"><strong>Notes:</strong><p>${invoice.notes}</p></div>` : ''}
${invoice.payment_link ? `<div style="margin-top:16px;text-align:center"><a href="${invoice.payment_link}" style="background:#1a1a2e;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px">Pay Now</a></div>` : ''}
<div class="footer">Generated by Echo Invoicing | echo-op.com</div>
</body></html>`;

  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `inline; filename="invoice-${invoice.invoice_number}.html"` } });
});

// ─────────────────────────────────────────
// AI ANALYSIS
// ─────────────────────────────────────────
app.post('/invoices/:id/analyze', async (c) => {
  if (!requireAuth(c, c.env)) return err('Unauthorized', 401);
  const invoice = await c.env.DB.prepare(
    'SELECT i.*, c.name as client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id WHERE i.id = ?'
  ).bind(c.req.param('id')).first<Invoice & { client_name: string }>();
  if (!invoice) return err('Invoice not found', 404);

  const daysUntilDue = Math.ceil((new Date(invoice.due_date).getTime() - Date.now()) / 86400000);
  const payments = await c.env.DB.prepare('SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0) as paid FROM payments WHERE invoice_id = ?').bind(c.req.param('id')).first<{ cnt: number; paid: number }>();
  const totalPaid = payments?.paid ?? 0;
  const remaining = invoice.total - totalPaid;

  try {
    const aiRes = await c.env.ENGINE_RUNTIME.fetch('https://echo-engine-runtime.internal/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine: 'financial-intelligence',
        prompt: `Analyze invoice #${invoice.invoice_number} for ${invoice.client_name}. Total: $${invoice.total}, Remaining: $${remaining}, Status: ${invoice.status}, Due in ${daysUntilDue} days. Provide: 1) Payment likelihood (0-100%), 2) Cash flow impact, 3) Collection recommendation.`,
        context: { invoice, daysUntilDue, totalPaid, remaining },
      }),
    });
    const aiData = await aiRes.json() as Record<string, unknown>;
    return c.json({ ok: true, invoice_id: c.req.param('id'), analysis: { days_until_due: daysUntilDue, remaining_balance: remaining, total_paid: totalPaid, ai: aiData } });
  } catch {
    const paymentLikelihood = invoice.status === 'paid' ? 100 : invoice.status === 'overdue' ? 45 : daysUntilDue < 0 ? 30 : daysUntilDue < 7 ? 70 : 85;
    return c.json({ ok: true, invoice_id: c.req.param('id'), analysis: { days_until_due: daysUntilDue, remaining_balance: remaining, total_paid: totalPaid, payment_likelihood: paymentLikelihood, recommendation: daysUntilDue < 0 ? 'Send payment reminder immediately' : daysUntilDue < 7 ? 'Follow up proactively' : 'No action needed', cash_flow_impact: `$${remaining.toFixed(2)} expected within ${Math.max(0, daysUntilDue)} days`, note: 'Engine Runtime unavailable — fallback analysis applied' } });
  }
});

// ─────────────────────────────────────────
// RECURRING INVOICES
// ─────────────────────────────────────────
app.get('/recurring', async (c) => {
  const tenantId = c.req.query('tenant_id');
  if (!tenantId) return err('tenant_id required');
  const recs = await c.env.DB.prepare(
    'SELECT r.*, c.name as client_name FROM recurring_invoices r LEFT JOIN clients c ON c.id = r.client_id WHERE r.tenant_id = ? ORDER BY r.next_date'
  ).bind(tenantId).all();
  return c.json({ ok: true, recurring: recs.results, total: recs.results.length });
});

app.post('/recurring', async (c) => {
  if (!requireAuth(c, c.env)) return err('Unauthorized', 401);
  const body = await c.req.json<{ tenant_id: string; client_id: string; frequency: string; next_date: string; template_data: unknown }>();
  if (!body.tenant_id || !body.client_id || !body.frequency || !body.next_date) return err('tenant_id, client_id, frequency, next_date required');
  const id = uid();
  await c.env.DB.prepare(
    `INSERT INTO recurring_invoices (id, tenant_id, client_id, frequency, next_date, template_data)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, body.tenant_id, body.client_id, body.frequency, body.next_date, JSON.stringify(body.template_data ?? {})).run();
  log('info', 'recurring.created', { id, frequency: body.frequency });
  const rec = await c.env.DB.prepare('SELECT * FROM recurring_invoices WHERE id = ?').bind(id).first();
  return c.json({ ok: true, recurring: rec }, 201);
});

app.get('/recurring/:id', async (c) => {
  const rec = await c.env.DB.prepare('SELECT * FROM recurring_invoices WHERE id = ?').bind(c.req.param('id')).first();
  if (!rec) return err('Recurring invoice not found', 404);
  return c.json({ ok: true, recurring: rec });
});

app.put('/recurring/:id', async (c) => {
  if (!requireAuth(c, c.env)) return err('Unauthorized', 401);
  const body = await c.req.json<{ frequency?: string; next_date?: string; template_data?: unknown }>();
  const existing = await c.env.DB.prepare('SELECT id FROM recurring_invoices WHERE id = ?').bind(c.req.param('id')).first();
  if (!existing) return err('Recurring invoice not found', 404);
  await c.env.DB.prepare(
    `UPDATE recurring_invoices SET frequency = COALESCE(?, frequency), next_date = COALESCE(?, next_date),
     template_data = COALESCE(?, template_data) WHERE id = ?`
  ).bind(body.frequency ?? null, body.next_date ?? null, body.template_data ? JSON.stringify(body.template_data) : null, c.req.param('id')).run();
  const rec = await c.env.DB.prepare('SELECT * FROM recurring_invoices WHERE id = ?').bind(c.req.param('id')).first();
  return c.json({ ok: true, recurring: rec });
});

app.patch('/recurring/:id/pause', async (c) => {
  if (!requireAuth(c, c.env)) return err('Unauthorized', 401);
  await c.env.DB.prepare("UPDATE recurring_invoices SET status = 'paused' WHERE id = ?").bind(c.req.param('id')).run();
  return c.json({ ok: true, status: 'paused', id: c.req.param('id') });
});

app.patch('/recurring/:id/resume', async (c) => {
  if (!requireAuth(c, c.env)) return err('Unauthorized', 401);
  await c.env.DB.prepare("UPDATE recurring_invoices SET status = 'active' WHERE id = ?").bind(c.req.param('id')).run();
  return c.json({ ok: true, status: 'active', id: c.req.param('id') });
});

// ─────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────
app.get('/reports/revenue', async (c) => {
  const tenantId = c.req.query('tenant_id');
  const period = c.req.query('period') ?? 'month';
  if (!tenantId) return err('tenant_id required');

  const fmt: Record<string, string> = { month: '%Y-%m', quarter: '%Y-Q', year: '%Y' };
  const groupFmt = fmt[period] ?? '%Y-%m';

  const sql = period === 'quarter'
    ? `SELECT strftime('%Y', paid_at) || '-Q' || ((CAST(strftime('%m', paid_at) AS INTEGER) - 1) / 3 + 1) as period, SUM(total) as revenue, COUNT(*) as count FROM invoices WHERE tenant_id = ? AND status = 'paid' GROUP BY period ORDER BY period DESC LIMIT 12`
    : `SELECT strftime('${groupFmt}', paid_at) as period, SUM(total) as revenue, COUNT(*) as count FROM invoices WHERE tenant_id = ? AND status = 'paid' GROUP BY period ORDER BY period DESC LIMIT 12`;

  const rows = await c.env.DB.prepare(sql).bind(tenantId).all();
  return c.json({ ok: true, period, revenue: rows.results });
});

app.get('/reports/aging', async (c) => {
  const tenantId = c.req.query('tenant_id');
  if (!tenantId) return err('tenant_id required');
  const today = new Date().toISOString().split('T')[0];

  const rows = await c.env.DB.prepare(
    `SELECT i.id, i.invoice_number, i.total, i.due_date, i.status, c.name as client_name,
     CAST(julianday('${today}') - julianday(i.due_date) AS INTEGER) as days_overdue
     FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
     WHERE i.tenant_id = ? AND i.status IN ('sent','viewed','overdue') ORDER BY days_overdue DESC`
  ).bind(tenantId).all<Invoice & { days_overdue: number; client_name: string }>();

  const buckets = { current: [] as unknown[], days_30: [] as unknown[], days_60: [] as unknown[], days_90_plus: [] as unknown[] };
  for (const row of rows.results) {
    if (row.days_overdue <= 0) buckets.current.push(row);
    else if (row.days_overdue <= 30) buckets.days_30.push(row);
    else if (row.days_overdue <= 60) buckets.days_60.push(row);
    else buckets.days_90_plus.push(row);
  }

  const sum = (arr: unknown[]) => (arr as Invoice[]).reduce((s, r) => s + r.total, 0);
  return c.json({
    ok: true,
    aging: {
      current: { invoices: buckets.current, total: parseFloat(sum(buckets.current).toFixed(2)) },
      '1_30_days': { invoices: buckets.days_30, total: parseFloat(sum(buckets.days_30).toFixed(2)) },
      '31_60_days': { invoices: buckets.days_60, total: parseFloat(sum(buckets.days_60).toFixed(2)) },
      '90_plus_days': { invoices: buckets.days_90_plus, total: parseFloat(sum(buckets.days_90_plus).toFixed(2)) },
      grand_total_outstanding: parseFloat((sum(buckets.current) + sum(buckets.days_30) + sum(buckets.days_60) + sum(buckets.days_90_plus)).toFixed(2)),
    },
  });
});

app.get('/reports/clients', async (c) => {
  const tenantId = c.req.query('tenant_id');
  if (!tenantId) return err('tenant_id required');
  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.name, c.company, c.email,
     COUNT(i.id) as invoice_count, COALESCE(SUM(CASE WHEN i.status='paid' THEN i.total ELSE 0 END),0) as total_revenue,
     COALESCE(SUM(CASE WHEN i.status IN ('sent','viewed','overdue') THEN i.total ELSE 0 END),0) as outstanding
     FROM clients c LEFT JOIN invoices i ON i.client_id = c.id
     WHERE c.tenant_id = ? GROUP BY c.id ORDER BY total_revenue DESC LIMIT 20`
  ).bind(tenantId).all();
  return c.json({ ok: true, clients: rows.results });
});

// ─────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────
app.get('/dashboard', async (c) => {
  const tenantId = c.req.query('tenant_id');
  if (!tenantId) return err('tenant_id required');

  const cacheKey = `dashboard:${tenantId}`;
  const cached = await c.env.CACHE.get(cacheKey);
  if (cached) return c.json({ ok: true, cached: true, ...JSON.parse(cached) });

  const [totals, outstanding, overdue, recent, upcoming] = await Promise.all([
    c.env.DB.prepare("SELECT COALESCE(SUM(total),0) as total_revenue, COUNT(*) as total_invoices FROM invoices WHERE tenant_id = ? AND status = 'paid'").bind(tenantId).first<{ total_revenue: number; total_invoices: number }>(),
    c.env.DB.prepare("SELECT COALESCE(SUM(total),0) as outstanding FROM invoices WHERE tenant_id = ? AND status IN ('sent','viewed','overdue')").bind(tenantId).first<{ outstanding: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as overdue_count FROM invoices WHERE tenant_id = ? AND status = 'overdue'").bind(tenantId).first<{ overdue_count: number }>(),
    c.env.DB.prepare("SELECT i.*, c.name as client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id WHERE i.tenant_id = ? ORDER BY i.created_at DESC LIMIT 5").bind(tenantId).all(),
    c.env.DB.prepare("SELECT r.*, c.name as client_name FROM recurring_invoices r LEFT JOIN clients c ON c.id = r.client_id WHERE r.tenant_id = ? AND r.status = 'active' ORDER BY r.next_date LIMIT 5").bind(tenantId).all(),
  ]);

  const dashboard = {
    total_revenue: parseFloat((totals?.total_revenue ?? 0).toFixed(2)),
    total_invoices_paid: totals?.total_invoices ?? 0,
    outstanding: parseFloat((outstanding?.outstanding ?? 0).toFixed(2)),
    overdue_count: overdue?.overdue_count ?? 0,
    recent_invoices: recent.results,
    upcoming_recurring: upcoming.results,
  };

  await c.env.CACHE.put(cacheKey, JSON.stringify(dashboard), { expirationTtl: 300 });
  return c.json({ ok: true, ...dashboard });
});

// ─────────────────────────────────────────
// CRON: Scheduled Handler
// ─────────────────────────────────────────
async function processScheduled(env: Env): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  log('info', 'cron.start', { today });

  // Mark overdue invoices
  const overdueResult = await env.DB.prepare(
    `UPDATE invoices SET status = 'overdue' WHERE status IN ('sent','viewed') AND due_date < ? AND status != 'overdue'`
  ).bind(today).run();
  log('info', 'cron.overdue_marked', { count: overdueResult.meta.changes });

  // Process recurring invoices due today
  const dueRecurring = await env.DB.prepare(
    `SELECT r.*, c.email as client_email FROM recurring_invoices r LEFT JOIN clients c ON c.id = r.client_id WHERE r.status = 'active' AND r.next_date <= ?`
  ).bind(today).all<{ id: string; tenant_id: string; client_id: string; frequency: string; next_date: string; template_data: string }>();

  let created = 0;
  for (const rec of dueRecurring.results) {
    try {
      const tmpl = JSON.parse(rec.template_data) as { items?: InvoiceItem[]; tax_rate?: number; discount?: number; notes?: string; due_days?: number };
      const dueDate = new Date(today);
      dueDate.setDate(dueDate.getDate() + (tmpl.due_days ?? 30));
      const invoiceId = uid();
      const invoiceNum = `REC-${Date.now()}`;
      const items: InvoiceItem[] = (tmpl.items ?? []).map((it: InvoiceItem, idx: number) => ({ ...it, amount: parseFloat((it.quantity * it.unit_price).toFixed(2)), sort_order: idx }));
      const { subtotal, tax_amount, total } = calcInvoiceTotals(items, tmpl.tax_rate ?? 0, tmpl.discount ?? 0);

      const stmts: D1PreparedStatement[] = [
        env.DB.prepare(`INSERT INTO invoices (id, tenant_id, client_id, invoice_number, due_date, subtotal, tax_rate, tax_amount, discount, total, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(invoiceId, rec.tenant_id, rec.client_id, invoiceNum, dueDate.toISOString().split('T')[0], subtotal, tmpl.tax_rate ?? 0, tax_amount, tmpl.discount ?? 0, total, tmpl.notes ?? null),
        ...items.map(it => env.DB.prepare(`INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount, tax_rate, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(uid(), invoiceId, it.description, it.quantity, it.unit_price, it.amount, it.tax_rate ?? 0, it.sort_order)),
        env.DB.prepare('UPDATE recurring_invoices SET next_date = ? WHERE id = ?').bind(addFrequencyDays(today, rec.frequency), rec.id),
      ];
      await env.DB.batch(stmts);
      created++;
      log('info', 'cron.recurring_invoice_created', { invoice_id: invoiceId, recurring_id: rec.id });
    } catch (e) {
      log('error', 'cron.recurring_failed', { recurring_id: rec.id, error: String(e) });
    }
  }
  log('info', 'cron.complete', { today, recurring_created: created, overdue_marked: overdueResult.meta.changes });
}

// ─────────────────────────────────────────
// Export with scheduled handler
// ─────────────────────────────────────────

app.onError((err, c) => {
  if (err.message?.includes('JSON')) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  console.error(`[echo-invoicing] ${err.message}`);
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await processScheduled(env);
  },
};
