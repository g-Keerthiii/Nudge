const $ = (s) => document.querySelector(s);
const api = async (p, o = {}) => { const r = await fetch(p, { ...o, headers: { 'content-type': 'application/json' }, body: o.body && JSON.stringify(o.body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; };
const money = (n, c = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(n);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500); };
const LABEL = { awaiting_reply: 'Awaiting reply', negotiating: 'Negotiating', needs_owner: 'Needs you', plan_agreed: 'Plan agreed', paid: 'Paid' };
let selected = null, rows = [], live = null, refreshTimer = null;

const grid = agGrid.createGrid($('#grid'), {
  getRowId: (p) => p.data.id,
  rowSelection: { mode: 'singleRow' },
  defaultColDef: { sortable: true, filter: true, resizable: true },
  columnDefs: [
    { field: 'number', headerName: 'Invoice', width: 105 },
    { field: 'clientName', headerName: 'Client', flex: 1, minWidth: 130 },
    { field: 'total', headerName: 'Amount', width: 110, filter: 'agNumberColumnFilter', valueFormatter: (p) => money(p.value, p.data.currency), cellClass: 'ag-right-aligned-cell' },
    { headerName: 'Collected', width: 170, sortable: true, valueGetter: (p) => p.data.paid / p.data.total, filter: false,
      cellRenderer: (p) => { const d = p.data; return `<div class="bar" style="margin-top:12px"><i style="width:${Math.min(100, (d.paid / d.total) * 100)}%"></i></div>`; },
      tooltipValueGetter: (p) => `${money(p.data.paid, p.data.currency)} of ${money(p.data.total, p.data.currency)}` },
    { field: 'due', headerName: 'Still owed', width: 120, filter: 'agNumberColumnFilter', valueFormatter: (p) => money(p.value, p.data.currency), cellClass: 'ag-right-aligned-cell' },
    { field: 'stage', headerName: 'Status', width: 140, cellRenderer: (p) => `<span class="chip ${p.value}">${LABEL[p.value] || p.value}</span>`, filterValueGetter: (p) => LABEL[p.data.stage] },
    { headerName: 'Plan', flex: 1, minWidth: 190, valueGetter: (p) => (p.data.plan ? p.data.plan.schedule.map((s) => `${money(s.amount, p.data.currency)}${s.paid ? ' ✓' : ''}`).join(' → ') : '—') },
    { headerName: '', width: 190, sortable: false, filter: false, cellRenderer: (p) => `<div class="row-actions"><button class="btn ghost" data-act="copy">Client link</button><button class="btn ghost" data-act="nudge">Nudge</button></div>` },
  ],
  pinnedBottomRowData: [],
  getRowClass: (p) => (p.data.stage === 'needs_owner' ? 'attn' : ''),
  onRowClicked: (e) => { selected = e.data.id; renderDetail(); },
  onCellClicked: async (e) => {
    const act = e.event.target.dataset?.act; if (!act) return;
    if (act === 'copy') { const url = `${location.origin}/pay/${e.data.id}`; await navigator.clipboard?.writeText(url).catch(() => {}); toast('Client link copied: ' + url); }
    if (act === 'nudge') { try { const r = await api(`/api/invoices/${e.data.id}/remind`, { method: 'POST' }); toast('Reminder sent: ' + r.note); } catch (err) { toast(err.message); } }
  },
});

async function refresh() {
  try {
    const [list, esc] = await Promise.all([api('/api/invoices'), api('/api/escalations')]);
    const prev = new Map(rows.map((r) => [r.id, r]));
    rows = list;
    const add = [], update = [];
    list.forEach((r) => (grid.getRowNode(r.id) ? update : add).push(r));
    grid.applyTransaction({ add, update });
    update.forEach((r) => { const o = prev.get(r.id); if (o && (o.paid !== r.paid || o.stage !== r.stage)) { const n = grid.getRowNode(r.id); grid.flashCells({ rowNodes: [n], columns: ['due', 'stage'] }); } });
    const tot = list.reduce((a, r) => ({ total: a.total + r.total, paid: a.paid + r.paid, due: a.due + r.due }), { total: 0, paid: 0, due: 0 });
    grid.setGridOption('pinnedBottomRowData', list.length ? [{ number: 'Total', clientName: `${list.length} invoices`, total: tot.total, due: tot.due, paid: tot.paid, currency: 'USD', stage: '' }] : []);
    $('#stat-total').textContent = money(tot.total);
    $('#stat-collected').textContent = money(tot.paid);
    $('#stat-outstanding').textContent = money(tot.due);
    $('#stat-collected-note').textContent = `${tot.total ? Math.round((tot.paid / tot.total) * 100) : 0}% of invoiced`;
    $('#stat-attention').textContent = esc.length;
    $('#approval-count').textContent = esc.length;
    $('#empty-grid').hidden = list.length > 0;
    $('#grid').hidden = list.length === 0;
    renderApprovals(esc); if (selected) renderDetail(true);
  } catch (e) { console.warn(e); }
}

function connectLive() {
  live?.close();
  live = new EventSource('/api/events');
  live.onopen = () => {};
  live.onmessage = () => refresh();
  live.onerror = () => {
    live.close();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(connectLive, 2500);
  };
}

function renderApprovals(items) {
  $('#approvalList').innerHTML = items.length ? items.map((e) => `<div class="item"><b>${esc(e.clientName)}</b> <span class="muted">${esc(e.number)} · ${money(e.due, e.currency)} owed</span>
    <div>Asks to pay: ${esc(e.describe)}</div><div class="danger">Outside your limits: ${e.violations.map((v) => esc(v.message)).join('; ')}</div>
    <div class="actions"><button class="btn ok" data-id="${e.id}" data-d="approve">Approve plan</button><button class="btn ghost" data-id="${e.id}" data-d="deny">Decline</button></div></div>`).join('') : '<div class="approval-empty"><span>✓</span><div><b>You are all clear</b><p>No payment plans need your decision.</p></div></div>';
}
$('#approvalList').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return; b.disabled = true;
  try { await api(`/api/escalations/${b.dataset.id}/${b.dataset.d}`, { method: 'POST' }); toast(b.dataset.d === 'approve' ? 'Approved. The client has been told.' : 'Declined. The client keeps the standing offer.'); refresh(); } catch (err) { toast(err.message); b.disabled = false; }
});

let lastDetail = '';
function renderDetail() {
  const r = rows.find((x) => x.id === selected); if (!r) return;
  const html = `<h2>${esc(r.clientName)} · ${esc(r.number)}</h2><p class="muted" style="margin:0">${esc(r.description)}. <a href="/pay/${r.id}" target="_blank" rel="noopener">Open client page</a></p>
    <div class="bar"><i style="width:${Math.min(100, (r.paid / r.total) * 100)}%"></i></div><p class="muted" style="margin:4px 0 0">${money(r.paid, r.currency)} collected of ${money(r.total, r.currency)}</p>
    ${r.warnings?.map((w) => `<p class="danger">${esc(w)}</p>`).join('') || ''}
    <div class="convo">${r.messages.length ? r.messages.map((m) => `<div class="msg ${m.role}"></div>`).join('') : '<p class="muted">No conversation yet. Send the client link, or open it yourself to play the client.</p>'}</div>`;
  if (html + r.messages.length === lastDetail) return; lastDetail = html + r.messages.length;
  const d = $('#detail'); d.hidden = false; d.innerHTML = html;
  d.querySelectorAll('.msg').forEach((el, i) => (el.textContent = (r.messages[i].role === 'agent' ? 'Nudge: ' : r.messages[i].role === 'client' ? r.clientName.split(' ')[0] + ': ' : '') + r.messages[i].text));
}

async function init() {
  const [cfg, rules] = await Promise.all([api('/api/config'), api('/api/rules')]);
  $('#avatar').textContent = cfg.owner ? cfg.owner.slice(0, 1).toUpperCase() : '';
  $('#emailHint').textContent = '(use your sandbox personal account email)';
  [['r1', 'minUpfrontPct'], ['r2', 'maxInstallments'], ['r3', 'maxDaysToPay'], ['r4', 'maxDiscountPct']].forEach(([id, k]) => ($('#' + id).value = rules[k]));
  $('#email').value = localStorage.getItem('nudge-email') || '';
  $('#focus-create').onclick = () => $('#text').focus();
  $('#empty-create').onclick = () => { $('#text').focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  await refresh();
  connectLive();
  setInterval(refresh, 15000);
};
$('#saveRules').onclick = async () => { const r = await api('/api/rules', { method: 'PUT', body: { minUpfrontPct: $('#r1').value, maxInstallments: $('#r2').value, maxDaysToPay: $('#r3').value, maxDiscountPct: $('#r4').value } }); toast(`Limits saved: ${r.minUpfrontPct}% first, ${r.maxInstallments} payments, ${r.maxDaysToPay} days`); };
$('#create').onclick = async (e) => {
  const b = e.target; b.disabled = true; $('#createMsg').className = 'form-message'; $('#createMsg').textContent = 'Creating invoice with PayPal and AI…'; localStorage.setItem('nudge-email', $('#email').value);
  try { const inv = await api('/api/invoices', { method: 'POST', body: { text: $('#text').value, clientEmail: $('#email').value } });
    $('#createMsg').textContent = `Sent ${inv.number} to ${inv.clientEmail}.`; selected = inv.id; $('#text').value = ''; await refresh(); }
  catch (err) { $('#createMsg').textContent = err.message; $('#createMsg').className = 'form-message danger'; }
  b.disabled = false;
};
init();
