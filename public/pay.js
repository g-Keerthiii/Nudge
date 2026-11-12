const id = location.pathname.split('/').pop();
const $ = (s) => document.querySelector(s);
const api = async (p, o = {}) => { const r = await fetch(p, { ...o, headers: { 'content-type': 'application/json' }, body: o.body && JSON.stringify(o.body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; };
const money = (n, c = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(n);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
let v = null, busy = false, sig = '', live = null, reconnectTimer = null;

function render() {
  const r = v, first = r.clientName.split(' ')[0];
  const rules = r.rules;
  const flex = `${r.ownerName} can usually do ${rules.maxInstallments > 1 ? `up to ${rules.maxInstallments} payments (first one at least ${rules.minUpfrontPct}%)` : 'one payment'} within ${rules.maxDaysToPay} days.`;
  let body = '';
  if (r.stage === 'paid') body = `<div class="paybox" style="border-color:var(--paid)"><h2>All paid. Thank you, ${esc(first)}.</h2><p class="muted" style="margin:6px 0 0">${esc(r.ownerName)} has been notified.</p></div>`;
  if (r.plan) {
    body += `<h3 style="margin-top:22px">Your plan</h3><div class="timeline">${r.plan.schedule.map((p) => `<div class="seg ${p.paid ? 'done' : p === r.nextPayment || p.n === r.nextPayment?.n ? 'next' : ''}"><b>${money(p.amount, r.currency)}</b><span>${p.paid ? 'Paid' : p.dueDate === new Date().toISOString().slice(0, 10) ? 'Today' : 'By ' + date(p.dueDate)}</span></div>`).join('')}</div>`;
    if (r.nextPayment) body += `<div class="paybox"><b>Next: ${money(r.nextPayment.amount, r.currency)}</b> <span class="muted">due ${date(r.nextPayment.dueDate)}</span>
      <div class="btns">${r.nextPayment ? '<button class="btn pay" id="pay-installment">Pay installment with PayPal</button>' : r.payUrl ? `<a class="btn pay" href="${esc(r.payUrl)}" target="_blank" rel="noopener" style="text-decoration:none">Pay invoice with PayPal</a>` : ''}</div>
      <p class="sandbox">Payments are processed by PayPal. Your installment opens in PayPal Checkout and returns here after payment.</p></div>`;
  } else if (r.stage !== 'paid') {
    if (r.currentOffer && r.stage !== 'needs_owner') body += `<div class="paybox"><b>Offer on the table</b><div class="timeline">${r.currentOffer.schedule.map((p, i) => `<div class="seg"><b>${money(p.amount, r.currency)}</b><span>${i === 0 && r.currentOffer.schedule.length > 1 ? 'Today' : 'By ' + date(p.dueDate)}</span></div>`).join('')}</div><div class="btns"><button class="btn ok" id="accept">Accept this plan</button></div></div>`;
    if (r.stage === 'needs_owner') body += `<div class="paybox" style="border-color:var(--owner)"><b>${esc(r.ownerName)} is reviewing your request.</b><p class="muted" style="margin:4px 0 0">This page updates by itself when they decide.</p></div>`;
    body += `<div class="chatbox" id="chat">${r.messages.map((m) => `<div class="msg ${m.role}">${esc(m.text)}</div>`).join('') || `<div class="msg agent">Hi ${esc(first)}, I'm Nudge, ${esc(r.ownerName)}'s assistant. If paying in full right now is tricky, tell me what would work and I'll see what I can arrange.</div>`}</div>
      <div class="quick">${["I can't pay in full yet", 'Can I pay in 2 parts?', 'I need 60 days'].map((t) => `<button class="btn ghost q">${t}</button>`).join('')}</div>
      <form class="composer" id="form"><input id="msg" autocomplete="off" maxlength="500" placeholder="Tell Nudge what works for you" aria-label="Message"><button class="btn">Send</button></form><p class="limits">${esc(flex)} Anything beyond that, Nudge can ask ${esc(r.ownerName)} for you.</p>`;
  } else body += `<div class="chatbox">${r.messages.map((m) => `<div class="msg ${m.role}">${esc(m.text)}</div>`).join('')}</div>`;
  if (r.plan) body += `<div class="chatbox" id="chat">${r.messages.map((m) => `<div class="msg ${m.role}">${esc(m.text)}</div>`).join('')}</div>`;
  $('#app').innerHTML = `<div class="head"><span class="muted">Invoice ${esc(r.number)} from ${esc(r.ownerName)}</span><h1>${esc(r.description)}</h1><div class="owed">${money(r.due, r.currency)}</div><span class="muted">still owed of ${money(r.total, r.currency)}${r.originalDueDate ? ' · originally due ' + date(r.originalDueDate) : ''}</span></div><div class="client-content">${body}</div>`;
  bind();
  const c = $('#chat'); if (c) c.scrollTop = c.scrollHeight;
}

function bind() {
  const send = async (payload) => { if (busy) return; busy = true; try { v = await api(`/api/invoices/${id}/chat`, { method: 'POST', body: payload }); } catch (e) { alert(e.message); } busy = false; sig = ''; render(); };
  $('#form')?.addEventListener('submit', (e) => { e.preventDefault(); const t = $('#msg').value.trim(); if (!t) return; $('#chat').insertAdjacentHTML('beforeend', `<div class="msg client">${esc(t)}</div><div class="msg agent muted">…</div>`); send({ message: t }); });
  document.querySelectorAll('.q').forEach((b) => (b.onclick = () => send({ message: b.textContent })));
  $('#accept')?.addEventListener('click', () => send({ message: 'Yes, I accept that plan.', accept: true }));
  $('#pay-installment')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Opening PayPal…';
    try { const order = await api(`/api/invoices/${id}/payment-order`, { method: 'POST' }); location.href = order.approveUrl; }
    catch (err) { alert(err.message); e.target.disabled = false; e.target.textContent = 'Pay installment with PayPal'; }
  });
}

async function poll() {
  if (busy || document.activeElement?.id === 'msg') return;
  try { const n = await api(`/api/invoices/${id}`); const s = JSON.stringify([n.messages.length, n.stage, n.paid, n.plan?.schedule.map((p) => p.paid)]); if (s !== sig) { sig = s; v = n; render(); } } catch { /* EventSource reconnects below. */ }
}

function connectLive() {
  live?.close();
  live = new EventSource('/api/events');
  live.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.invoiceId === id) poll();
  };
  live.onerror = () => {
    live.close();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectLive, 2500);
  };
}

(async () => {
  const token = new URLSearchParams(location.search).get('token');
  if (token && new URLSearchParams(location.search).get('payment') === 'success') {
    try { await api(`/api/invoices/${id}/payment-order/capture`, { method: 'POST', body: { orderId: token } }); history.replaceState({}, '', `/pay/${id}`); }
    catch (e) { alert(`Payment could not be completed: ${e.message}`); }
  }
  try { await poll(); } catch { $('#app').innerHTML = '<p>We could not find this invoice.</p>'; }
  connectLive();
  setInterval(poll, 15000);
})();
