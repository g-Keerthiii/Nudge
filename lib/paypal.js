// PayPal Invoicing API v2 client (sandbox by default).
import { round2 } from './rules.js';

const BASE = () => process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com';
const env = () => ({ clientId: process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.PAYPAL_CLIENT_SECRET, businessEmail: process.env.PAYPAL_BUSINESS_EMAIL });
export const environment = () => process.env.PAYPAL_BASE?.includes('api-m.paypal.com') ? 'live' : 'sandbox';

export function assertConfigured() {
  const names = { clientId: 'PAYPAL_CLIENT_ID', clientSecret: 'PAYPAL_CLIENT_SECRET', businessEmail: 'PAYPAL_BUSINESS_EMAIL' };
  const missing = Object.entries(env()).filter(([, value]) => !value).map(([key]) => names[key]);
  if (missing.length) throw new Error(`Missing PayPal configuration: ${missing.join(', ')}`);
}

let tok = { value: null, exp: 0 };
async function token() {
  assertConfigured();
  if (tok.value && Date.now() < tok.exp) return tok.value;
  const { clientId, clientSecret } = env();
  const r = await fetch(`${BASE()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`PayPal auth failed: ${j.error_description || r.status}`);
  tok = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return tok.value;
}

async function pp(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${BASE()}${path}`, {
    method,
    headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(`PayPal ${method} ${path} -> ${r.status} ${j.name || ''} ${j.message || ''} ${JSON.stringify(j.details || '')} (debug_id ${j.debug_id || '-'})`);
  return j;
}

const splitName = (full = '') => { const p = full.trim().split(/\s+/); return { given_name: p[0] || 'Client', surname: p.slice(1).join(' ') || '.' }; };
const val = (cur, n) => ({ currency_code: cur, value: round2(n).toFixed(2) });

export async function createInvoice(a) {
  // a: { clientName, clientEmail, description, amount, currency, dueDate }
  const currency = (process.env.PAYPAL_CURRENCY || a.currency || 'USD').toUpperCase();
  let number;
  number = (await pp('/v2/invoicing/generate-next-invoice-number', { method: 'POST' })).invoice_number;
  const today = new Date().toISOString().slice(0, 10);
  const payload = {
    detail: {
      invoice_number: number, invoice_date: today, currency_code: currency,
      note: 'Thanks for your business. Reply in the Nudge chat if you need a payment plan.',
      payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: a.dueDate < today ? today : a.dueDate },
    },
    invoicer: { email_address: env().businessEmail, name: { given_name: 'Nudge', surname: 'Receivables' } },
    primary_recipients: [{ billing_info: { name: splitName(a.clientName), email_address: a.clientEmail } }],
    items: [{ name: a.description.slice(0, 100), quantity: '1', unit_amount: val(currency, a.amount) }],
    configuration: {
      allow_tip: false,
    },
  };
  const res = await pp('/v2/invoicing/invoices', { method: 'POST', body: payload });
  const ppId = res.href.split('/').pop();
  return { ppId, number, payload };
}

export async function sendInvoice(ppId) {
  await pp(`/v2/invoicing/invoices/${ppId}/send`, { method: 'POST', body: { send_to_recipient: true, send_to_invoicer: false } });
}

export async function getInvoice(ppId) {
  const j = await pp(`/v2/invoicing/invoices/${ppId}`);
  const total = Number(j.amount?.value ?? 0);
  const due = Number(j.due_amount?.value ?? total);
  const paid = Number(j.payments?.paid_amount?.value ?? round2(total - due));
  return {
    status: j.status, total, paid, due,
    payUrl: j.detail?.metadata?.recipient_view_url || null,
    payments: (j.payments?.transactions || []).map((t) => ({ amount: Number(t.amount?.value), date: t.payment_date, method: t.method })),
  };
}

// Update the due date of an already-sent invoice. Payment-plan terms are tracked by Nudge.
export async function updateInvoicePlan(ppId, payload, { dueDate }) {
  if (!payload) throw new Error('no stored payload to update');
  const next = structuredClone(payload);
  const today = new Date().toISOString().slice(0, 10);
  next.detail.payment_term.due_date = dueDate < today ? today : dueDate;
  await pp(`/v2/invoicing/invoices/${ppId}?send_to_recipient=false&send_to_invoicer=false`, { method: 'PUT', body: next });
}

export async function createOrder({ amount, currency, description, returnUrl, cancelUrl }) {
  const j = await pp('/v2/checkout/orders', {
    method: 'POST',
    body: {
      intent: 'CAPTURE',
      purchase_units: [{ description: description.slice(0, 127), amount: val(currency, amount) }],
      application_context: {
        brand_name: 'Nudge',
        user_action: 'PAY_NOW',
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    },
  });
  const approve = j.links?.find((link) => link.rel === 'approve')?.href;
  if (!approve) throw new Error('PayPal order did not return an approval link');
  return { id: j.id, approveUrl: approve };
}

export async function captureOrder(orderId) {
  const j = await pp(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST', body: {} });
  const capture = j.purchase_units?.[0]?.payments?.captures?.[0];
  if (j.status !== 'COMPLETED' || capture?.status !== 'COMPLETED') throw new Error(`PayPal order was not completed (${j.status || 'unknown'})`);
  return { id: j.id, amount: Number(capture.amount?.value), currency: capture.amount?.currency_code };
}

export async function remind(ppId, note) {
  await pp(`/v2/invoicing/invoices/${ppId}/remind`, { method: 'POST', body: { subject: 'A quick nudge about your invoice', note, send_to_invoicer: false } });
}

export async function verifyWebhook(headers, rawBody) {
  const webhook_id = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhook_id) return true;
  const r = await pp('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: {
      auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'],
      webhook_id, webhook_event: JSON.parse(rawBody),
    },
  });
  return r.verification_status === 'SUCCESS';
}
