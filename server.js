import dotenv from 'dotenv';
dotenv.config({ override: true });
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { store, save, uid } from './lib/store.js';
import { sanitizeRules, normalizeOffer, validateOffer, clampOffer, buildSchedule, describeOffer, round2, money, addDays } from './lib/rules.js';
import * as PP from './lib/paypal.js';
import { parseInvoiceText, negotiate, reminderNote, llmName, assertConfigured as assertLLMConfigured } from './lib/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const OWNER = process.env.OWNER_NAME;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- helpers ----------
const db = () => store();
const find = (id) => db().invoices[id];
const say = (inv, role, text, meta) => { inv.messages.push({ role, text, ts: Date.now(), ...(meta ? { meta } : {}) }); };
const liveClients = new Set();
const publish = (type, invoiceId = null) => {
  const payload = `data: ${JSON.stringify({ type, invoiceId, at: Date.now() })}\n\n`;
  for (const client of liveClients) {
    try { client.res.write(payload); } catch { liveClients.delete(client); }
  }
};

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  res.flushHeaders();
  const client = { id: randomUUID(), res };
  liveClients.add(client);
  res.write(`data: ${JSON.stringify({ type: 'connected', at: Date.now() })}\n\n`);
  const heartbeat = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch { clearInterval(heartbeat); liveClients.delete(client); }
  }, 20000);
  req.on('close', () => { clearInterval(heartbeat); liveClients.delete(client); });
});

async function sync(inv) {
  try {
    const g = await PP.getInvoice(inv.ppId);
    const paid = round2(Math.max(g.paid, inv.planPaid || 0));
    const due = round2(Math.max(0, inv.total - paid));
    const changed = inv.status !== g.status || inv.paid !== paid || inv.due !== due;
    Object.assign(inv, { status: g.status, paid, due, payUrl: g.payUrl, payments: g.payments, syncedAt: Date.now() });
    save();
    if (changed) publish('invoice.updated', inv.id);
  } catch (e) { log('sync failed', inv.id, e.message); }
}

function stage(inv) {
  if (['PAID', 'MARKED_AS_PAID'].includes(inv.status) || inv.due <= 0.005) return 'paid';
  if (db().escalations[inv.escalationId]?.status === 'pending') return 'needs_owner';
  if (inv.plan) return 'plan_agreed';
  if (inv.messages.length) return 'negotiating';
  return 'awaiting_reply';
}

function view(inv, full = false) {
  const plan = inv.plan && {
    ...inv.plan,
    schedule: (() => { let cum = 0; const paidSince = round2(inv.paid - inv.plan.basePaid); return inv.plan.schedule.map((p) => { cum = round2(cum + p.amount); return { ...p, paid: paidSince >= cum - 0.005 }; }); })(),
  };
  const nextPayment = plan?.schedule.find((p) => !p.paid) || null;
  const esc = db().escalations[inv.escalationId];
  return {
    id: inv.id, number: inv.number, clientName: inv.clientName, clientEmail: full ? inv.clientEmail : undefined, description: inv.description,
    currency: inv.currency, total: inv.total, paid: inv.paid, due: inv.due, status: inv.status, stage: stage(inv),
    originalDueDate: inv.originalDueDate, createdAt: inv.createdAt, payUrl: inv.payUrl, warnings: inv.warnings,
    plan, nextPayment, currentOffer: inv.currentOffer ? { ...inv.currentOffer } : null,
    escalation: esc ? { id: esc.id, status: esc.status } : null, messages: inv.messages, ownerName: OWNER,
    rules: db().rules,
  };
}

async function finalizePlan(inv, offer, via) {
  const schedule = buildSchedule(inv.due, offer);
  inv.plan = { offer: normalizeOffer(offer, inv.due), schedule, via, agreedAt: Date.now(), basePaid: inv.paid };
  inv.currentOffer = null; inv.lastRequest = null;
  const last = schedule[schedule.length - 1].dueDate;
  try {
    await PP.updateInvoicePlan(inv.ppId, inv.payload, { dueDate: last });
  } catch (e) { inv.warnings.push('PayPal invoice update failed: ' + e.message.slice(0, 160)); log('updateInvoicePlan', e.message); }
  save();
}

// ---------- config / rules ----------
app.get('/api/config', (req, res) => res.json({ paypal: PP.environment(), llm: llmName(), owner: OWNER }));
app.get('/api/rules', (req, res) => res.json(db().rules));
app.put('/api/rules', express.json(), (req, res) => { db().rules = sanitizeRules(req.body); save(); res.json(db().rules); });

// ---------- invoices ----------
app.post('/api/invoices', express.json(), async (req, res) => {
  try {
    const { text = '', clientEmail } = req.body;
    if (!text.trim()) return res.status(400).json({ error: 'Describe who owes what.' });
    const email = String(clientEmail || '').trim();
    if (!email) return res.status(400).json({ error: "Add the client's email (in sandbox, use your sandbox personal account email)." });
    const p = await parseInvoiceText(text);
    const currency = (process.env.PAYPAL_CURRENCY || 'USD').toUpperCase();
    const created = await PP.createInvoice({ ...p, currency, clientEmail: email });
    await PP.sendInvoice(created.ppId);
    const inv = {
      id: uid('i'), ppId: created.ppId, number: created.number, clientName: p.clientName, clientEmail: email, description: p.description,
      currency, total: p.amount, paid: 0, due: p.amount, status: 'UNPAID', originalDueDate: p.dueDate, createdAt: Date.now(),
      payload: created.payload, warnings: [], messages: [], plan: null, currentOffer: null, lastRequest: null, escalationId: null, payUrl: null, payments: [], planPaid: 0, paymentOrders: [],
    };
    db().invoices[inv.id] = inv;
    await sync(inv);
    publish('invoice.created', inv.id);
    log('invoice created', inv.id, inv.ppId, p);
    res.json(view(inv, true));
  } catch (e) { log('create failed', e.message); res.status(502).json({ error: e.message }); }
});

let lastBulk = 0;
app.get('/api/invoices', async (req, res) => {
  const list = Object.values(db().invoices).sort((a, b) => b.createdAt - a.createdAt);
  if (Date.now() - lastBulk > 4000) { lastBulk = Date.now(); await Promise.all(list.filter((i) => stage(i) !== 'paid').map(sync)); }
  res.json(list.map((i) => view(i, true)));
});

app.get('/api/invoices/:id', async (req, res) => {
  const inv = find(req.params.id); if (!inv) return res.status(404).json({ error: 'not found' });
  if (Date.now() - (inv.syncedAt || 0) > 2500) await sync(inv);
  res.json(view(inv));
});

app.post('/api/invoices/:id/chat', express.json(), async (req, res) => {
  const inv = find(req.params.id); if (!inv) return res.status(404).json({ error: 'not found' });
  const message = String(req.body.message || '').slice(0, 500).trim();
  if (!message) return res.status(400).json({ error: 'empty' });
  if (inv.messages.length > 60) return res.status(429).json({ error: 'conversation limit reached' });
  if (stage(inv) === 'paid') return res.json(view(inv));
  const rules = db().rules;
  say(inv, 'client', message);
  const esc = db().escalations[inv.escalationId];
  let r;
  if (req.body.accept && inv.currentOffer) r = { action: 'accept', reply: '' };
  else try { r = await negotiate({ invoice: { ...inv, escalationPending: esc?.status === 'pending' }, rules, history: inv.messages, message, ownerName: OWNER }); }
  catch (e) { log('negotiate failed', inv.id, e.message); return res.status(502).json({ error: `AI request failed: ${e.message}` }); }

  const asked = (o) => normalizeOffer(o || inv.lastRequest || {}, inv.due);
  let reply = String(r.reply || '').slice(0, 400), meta;
  let action = r.action;

  if ((action === 'propose' || action === 'escalate') && (r.offer || inv.lastRequest)) {
    const offer = asked(r.offer);
    const violations = validateOffer(inv.due, offer, rules);
    if (!violations.length) {
      inv.currentOffer = { offer, schedule: buildSchedule(inv.due, offer) }; inv.lastRequest = null;
      meta = { kind: 'offer' };
      if (action === 'escalate') reply = `That already fits ${OWNER}'s limits, so no approval is needed: ${describeOffer(inv.due, offer, inv.currency)}. Does that work?`;
    } else if (action === 'escalate') {
      const e = { id: uid('e'), invoiceId: inv.id, requested: offer, schedule: buildSchedule(inv.due, offer), violations, status: 'pending', note: message, createdAt: Date.now() };
      db().escalations[e.id] = e; inv.escalationId = e.id; inv.lastRequest = offer;
      reply = `I can't approve that myself, so I've sent your request to ${OWNER} for review (${describeOffer(inv.due, offer, inv.currency)}). I'll update this chat as soon as they decide.`;
      meta = { kind: 'escalated' };
    } else {
      const counter = clampOffer(inv.due, offer, rules);
      inv.lastRequest = offer; inv.currentOffer = { offer: counter, schedule: buildSchedule(inv.due, counter) };
      reply = `I can't do that exactly: ${violations.map((v) => v.message).join('; ')}. The closest I can offer is: ${describeOffer(inv.due, counter, inv.currency)}. If that doesn't work, I can ask ${OWNER} to review your request.`;
      meta = { kind: 'counter', violations: violations.map((v) => v.code) };
    }
  } else if (action === 'accept' && inv.currentOffer) {
    if (esc?.status === 'pending') esc.status = 'withdrawn';
    const offer = inv.currentOffer.offer;
    await finalizePlan(inv, offer, 'auto');
    reply = `Done. Your plan is confirmed: ${describeOffer(inv.due, offer, inv.currency)}. Use the button below to make your first payment through PayPal.`;
    meta = { kind: 'plan' };
  } else if (action === 'accept') { reply = reply || 'Could you tell me what would work for you?'; }
  say(inv, 'agent', reply, meta);
  save();
  publish('invoice.updated', inv.id);
  res.json(view(inv));
});

// ---------- owner approvals ----------
app.get('/api/escalations', (req, res) => {
  res.json(Object.values(db().escalations).filter((e) => e.status === 'pending').map((e) => {
    const inv = find(e.invoiceId); return { ...e, clientName: inv?.clientName, due: inv?.due, currency: inv?.currency, number: inv?.number, describe: describeOffer(inv.due, e.requested, inv.currency) };
  }));
});
app.post('/api/escalations/:id/:decision', async (req, res) => {
  const e = db().escalations[req.params.id]; if (!e || e.status !== 'pending') return res.status(404).json({ error: 'not pending' });
  const inv = find(e.invoiceId);
  if (req.params.decision === 'approve') {
    e.status = 'approved';
    await finalizePlan(inv, e.requested, 'owner-approved');
    say(inv, 'agent', `${OWNER} approved your request. Your plan: ${describeOffer(inv.due, e.requested, inv.currency)}. You can make the first payment below.`, { kind: 'plan' });
  } else {
    e.status = 'denied';
    const counter = clampOffer(inv.due, e.requested, db().rules);
    inv.currentOffer = { offer: counter, schedule: buildSchedule(inv.due, counter) };
    say(inv, 'agent', `${OWNER} wasn't able to approve that one. The standing offer is still available: ${describeOffer(inv.due, counter, inv.currency)}. Reply "yes" to accept it.`, { kind: 'counter' });
  }
  save(); publish('escalation.updated', inv.id); res.json({ ok: true });
});

// ---------- payments ----------
app.post('/api/invoices/:id/payment-order', async (req, res) => {
  const inv = find(req.params.id); if (!inv) return res.status(404).json({ error: 'not found' });
  if (!Array.isArray(inv.paymentOrders)) inv.paymentOrders = [];
  const next = view(inv).nextPayment;
  if (!next) return res.status(409).json({ error: 'There is no payment due for this invoice.' });
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  try {
    const order = await PP.createOrder({
      amount: next.amount, currency: inv.currency, description: `${inv.description} · payment ${next.n} of ${inv.plan.schedule.length}`,
      returnUrl: `${base}/pay/${inv.id}?payment=success`, cancelUrl: `${base}/pay/${inv.id}?payment=cancelled`,
    });
    inv.paymentOrders.push({ id: order.id, amount: next.amount, status: 'CREATED', createdAt: Date.now() });
    save();
    res.json({ approveUrl: order.approveUrl });
  }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/invoices/:id/payment-order/capture', express.json(), async (req, res) => {
  const inv = find(req.params.id); if (!inv) return res.status(404).json({ error: 'not found' });
  if (!Array.isArray(inv.paymentOrders)) inv.paymentOrders = [];
  const orderId = String(req.body.orderId || '');
  const order = inv.paymentOrders.find((item) => item.id === orderId);
  if (!order) return res.status(404).json({ error: 'payment order not found' });
  if (order.status === 'COMPLETED') return res.json(view(inv));
  try {
    const captured = await PP.captureOrder(orderId);
    if (captured.currency !== inv.currency || Math.abs(captured.amount - order.amount) > 0.005) throw new Error('Captured amount does not match the scheduled payment');
    order.status = 'COMPLETED'; order.completedAt = Date.now(); inv.planPaid = round2((inv.planPaid || 0) + captured.amount);
    await sync(inv); say(inv, 'system', `Payment of ${money(captured.amount, inv.currency)} received.`, { kind: 'payment' }); save(); publish('payment.received', inv.id); res.json(view(inv));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/invoices/:id/remind', async (req, res) => {
  const inv = find(req.params.id); if (!inv) return res.status(404).json({ error: 'not found' });
  try { const note = await reminderNote({ invoice: inv, ownerName: OWNER }); await PP.remind(inv.ppId, note); res.json({ note }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/webhooks/paypal', express.text({ type: '*/*' }), async (req, res) => {
  try {
    if (!(await PP.verifyWebhook(req.headers, req.body))) return res.sendStatus(400);
    const ev = JSON.parse(req.body); const id = ev.resource?.id || ev.resource?.invoice?.id;
    const inv = Object.values(db().invoices).find((i) => i.ppId === id);
    log('webhook', ev.event_type, id, inv ? 'matched' : 'no match');
    if (inv) { await sync(inv); publish('invoice.updated', inv.id); }
    res.sendStatus(200);
  } catch (e) { log('webhook error', e.message); res.sendStatus(500); }
});

// ---------- static ----------
app.use('/vendor/ag-grid', express.static(path.join(__dirname, 'node_modules/ag-grid-community')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/owner.html')));
app.get('/pay/:id', (req, res) => res.sendFile(path.join(__dirname, 'public/pay.html')));
app.use(express.static(path.join(__dirname, 'public')));

const port = process.env.PORT || 3000;
if (!OWNER) throw new Error('Missing OWNER_NAME configuration');
PP.assertConfigured();
assertLLMConfigured();
app.listen(port, () => log(`Nudge on :${port} | PayPal: ${PP.environment()} | LLM: ${llmName()}`));
